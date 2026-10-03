// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

// trace_processor GLOB and SQLite LIKE patterns as anchored RegExps, for code
// that must agree with what a Skill's SQL would match.

const escapeRegExp = (text: string) => text.replace(/[.*+?^${}()|[\]\\/-]/g, '\\$&');

/** A pattern that matches nothing. */
const MATCHES_NOTHING = /(?!)/;

/**
 * The members of a GLOB class as trace_processor reads them (its own
 * GlobMatcher, perfetto/src/trace_processor/util/glob.cc, replaces SQLite's):
 * every character but an interior `-` is a member, and each interior `-`
 * adds the range from the character before it to the one after it, so ranges
 * chain (`a-c-e` is a to e) and a reversed range adds nothing.
 */
function globClassMembers(members: string): string {
  let source = '';
  for (let index = 0; index < members.length; index++) {
    const char = members[index];
    const interiorDash = char === '-' && index > 0 && index < members.length - 1;
    if (!interiorDash) source += escapeRegExp(char);
    else if (members[index - 1] <= members[index + 1]) {
      source += `${escapeRegExp(members[index - 1])}-${escapeRegExp(members[index + 1])}`;
    }
  }
  return source;
}

/**
 * A GLOB pattern as trace_processor reads it: case-sensitive, whole string; `*` any
 * run, `?` one character, `[...]` a class where `^` first negates and a `]`
 * first (after any `^`) is a member.
 *
 * Two corners of glob.cc are not modelled, and no Skill pattern reaches them:
 * an unterminated `[` here matches nothing, where glob.cc may read it as a
 * literal (`'a[' GLOB 'a['` is 1); and glob.cc lets a middle segment overlap
 * the end-anchored last one (`'ab' GLOB 'ab*ab'` is 1), which this does not.
 */
export function sqliteGlobRegExp(glob: string): RegExp {
  let source = '';
  for (let index = 0; index < glob.length; index++) {
    const char = glob[index];
    if (char === '*') source += '[\\s\\S]*';
    else if (char === '?') source += '[\\s\\S]';
    else if (char === '[') {
      let cursor = index + 1;
      const negated = glob[cursor] === '^';
      if (negated) cursor++;
      const first = cursor;
      if (glob[cursor] === ']') cursor++;
      const close = glob.indexOf(']', cursor);
      if (close < 0) return MATCHES_NOTHING;
      source += `[${negated ? '^' : ''}${globClassMembers(glob.slice(first, close))}]`;
      index = close;
    } else source += escapeRegExp(char);
  }
  return new RegExp(`^${source}$`);
}

/**
 * A LIKE pattern as SQLite reads it (trace_processor keeps SQLite's LIKE):
 * `%` any run, `_` one character, the character after `escape` literal (an
 * escape with nothing after it matches nothing), and case folded for ASCII
 * letters only.
 */
export function sqliteLikeRegExp(like: string, escape?: string): RegExp {
  let source = '';
  const chars = [...like];
  for (let index = 0; index < chars.length; index++) {
    let char = chars[index];
    if (escape !== undefined && char === escape) {
      if (index + 1 === chars.length) return MATCHES_NOTHING;
      char = chars[++index];
    }
    else if (char === '%') { source += '[\\s\\S]*'; continue; }
    else if (char === '_') { source += '[\\s\\S]'; continue; }
    source += /[a-z]/i.test(char) ? `[${char.toLowerCase()}${char.toUpperCase()}]` : escapeRegExp(char);
  }
  return new RegExp(`^${source}$`);
}
