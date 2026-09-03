// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

export interface RawSqlNormalizationResult {
  sql: string;
  rewrites: string[];
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function maskSqlLiteralsCommentsAndQuotedIdentifiers(sql: string): string {
  const chars = sql.split('');
  const maskRange = (start: number, end: number) => {
    for (let i = start; i < end; i += 1) {
      if (chars[i] !== '\n' && chars[i] !== '\r') chars[i] = ' ';
    }
  };

  let i = 0;
  while (i < sql.length) {
    const char = sql[i];
    const next = sql[i + 1];

    if (char === '-' && next === '-') {
      const start = i;
      i += 2;
      while (i < sql.length && sql[i] !== '\n' && sql[i] !== '\r') i += 1;
      maskRange(start, i);
      continue;
    }

    if (char === '/' && next === '*') {
      const start = i;
      i += 2;
      while (i < sql.length && !(sql[i] === '*' && sql[i + 1] === '/')) i += 1;
      i = Math.min(sql.length, i + 2);
      maskRange(start, i);
      continue;
    }

    if (char === '\'' || char === '"' || char === '`') {
      const quote = char;
      const start = i;
      i += 1;
      while (i < sql.length) {
        if (sql[i] === quote) {
          if (sql[i + 1] === quote) {
            i += 2;
            continue;
          }
          i += 1;
          break;
        }
        i += 1;
      }
      maskRange(start, i);
      continue;
    }

    if (char === '[') {
      const start = i;
      i += 1;
      while (i < sql.length && sql[i] !== ']') i += 1;
      i = Math.min(sql.length, i + 1);
      maskRange(start, i);
      continue;
    }

    i += 1;
  }

  return chars.join('');
}

function replaceOutsideSqlLiteralsCommentsAndQuotedIdentifiers(
  sql: string,
  pattern: RegExp,
  replacement: (match: string, ...args: string[]) => string,
): { sql: string; count: number } {
  const masked = maskSqlLiteralsCommentsAndQuotedIdentifiers(sql);
  const flags = pattern.flags.includes('g') ? pattern.flags : `${pattern.flags}g`;
  const matcher = new RegExp(pattern.source, flags);
  let match: RegExpExecArray | null;
  let rewritten = '';
  let lastIndex = 0;
  let count = 0;

  while ((match = matcher.exec(masked)) !== null) {
    count += 1;
    rewritten += sql.slice(lastIndex, match.index);
    rewritten += replacement(sql.slice(match.index, matcher.lastIndex), ...match.slice(1));
    lastIndex = matcher.lastIndex;
    if (match[0].length === 0) matcher.lastIndex += 1;
  }

  if (count === 0) return { sql, count: 0 };
  rewritten += sql.slice(lastIndex);
  return { sql: rewritten, count };
}

function skipSqlIgnoredText(sql: string, index: number): number {
  const char = sql[index];
  const next = sql[index + 1];
  if (char === '-' && next === '-') {
    let i = index + 2;
    while (i < sql.length && sql[i] !== '\n' && sql[i] !== '\r') i += 1;
    return i;
  }
  if (char === '/' && next === '*') {
    let i = index + 2;
    while (i < sql.length && !(sql[i] === '*' && sql[i + 1] === '/')) i += 1;
    return Math.min(sql.length, i + 2);
  }
  if (char === '\'' || char === '"' || char === '`') {
    let i = index + 1;
    while (i < sql.length) {
      if (sql[i] === char) {
        if (sql[i + 1] === char) {
          i += 2;
          continue;
        }
        return i + 1;
      }
      i += 1;
    }
    return sql.length;
  }
  if (char === '[') {
    let i = index + 1;
    while (i < sql.length && sql[i] !== ']') i += 1;
    return Math.min(sql.length, i + 1);
  }
  return index;
}

function readSqlIdentifierToken(sql: string, index: number): { value: string; end: number } | null {
  const char = sql[index];
  if (char === '\'' || char === '"' || char === '`') {
    const end = skipSqlIgnoredText(sql, index);
    const inner = sql.slice(index + 1, end - 1).split(`${char}${char}`).join(char);
    return { value: inner, end };
  }
  if (char === '[') {
    const end = skipSqlIgnoredText(sql, index);
    return { value: sql.slice(index + 1, end - 1), end };
  }

  let i = index;
  while (i < sql.length && /[A-Za-z0-9_$-]/.test(sql[i])) i += 1;
  if (i === index) return null;
  return { value: sql.slice(index, i), end: i };
}

function readSqlTableNameAfterFromOrJoin(sql: string, index: number): { tableName: string; end: number } | null {
  let i = index;
  while (i < sql.length && /\s/.test(sql[i])) i += 1;
  if (sql[i] === '(') return null;

  let token = readSqlIdentifierToken(sql, i);
  if (!token) return null;
  let tableName = token.value;
  i = token.end;

  while (i < sql.length && /\s/.test(sql[i])) i += 1;
  if (sql[i] === '.') {
    i += 1;
    while (i < sql.length && /\s/.test(sql[i])) i += 1;
    token = readSqlIdentifierToken(sql, i);
    if (token) {
      tableName = token.value;
      i = token.end;
    }
  }

  return { tableName, end: i };
}

const TABLE_ALIAS_BOUNDARY_WORD = /^(WHERE|JOIN|LEFT|RIGHT|INNER|OUTER|CROSS|FULL|NATURAL|GROUP|ORDER|LIMIT|ON|USING|HAVING|UNION|EXCEPT|INTERSECT|WINDOW|QUALIFY|VALUES)$/i;

function readOptionalSqlAliasToken(sql: string, index: number): { value: string; end: number } | null {
  let i = index;
  while (i < sql.length && /\s/.test(sql[i])) i += 1;
  const asMatch = /^AS\b/i.exec(sql.slice(i));
  if (asMatch) {
    i += asMatch[0].length;
    while (i < sql.length && /\s/.test(sql[i])) i += 1;
  }

  const token = readSqlIdentifierToken(sql, i);
  if (!token) return null;
  if (TABLE_ALIAS_BOUNDARY_WORD.test(token.value)) {
    return null;
  }
  return token;
}

function readOptionalSqlAlias(sql: string, index: number): string | null {
  return readOptionalSqlAliasToken(sql, index)?.value ?? null;
}

const THREAD_SLICE_FROM = /\bFROM\s+thread_slice(?:\s+(?:AS\s+)?(?!WHERE\b|JOIN\b|LEFT\b|RIGHT\b|INNER\b|OUTER\b|CROSS\b|GROUP\b|ORDER\b|LIMIT\b|ON\b|USING\b)([A-Za-z_]\w*))?/i;
const SLICE_FROM_WITH_ALIAS = /\bFROM\s+slice\s+(?:AS\s+)?([A-Za-z_]\w*)\b/i;

function findThreadSliceAlias(sql: string): string | undefined {
  return THREAD_SLICE_FROM.exec(sql)?.[1];
}

function hasSqlAlias(sql: string, alias: string): boolean {
  return new RegExp(`\\b(?:FROM|JOIN)\\s+(?:"[^"]+"|[A-Za-z_]\\w*)(?:\\s+(?:AS\\s+)?)${escapeRegExp(alias)}\\b`, 'i')
    .test(sql);
}

function columnRef(base: string | undefined, column: string): string {
  return base ? `${base}.${column}` : column;
}

function replaceDanglingAliasColumn(
  sql: string,
  alias: string,
  column: string,
  replacement: string,
): { sql: string; count: number } {
  let count = 0;
  const pattern = new RegExp(`\\b${escapeRegExp(alias)}\\.${escapeRegExp(column)}\\b`, 'gi');
  const nextSql = sql.replace(pattern, () => {
    count += 1;
    return replacement;
  });
  return { sql: nextSql, count };
}

function normalizeReversedLiteralBetween(sql: string): { sql: string; count: number } {
  let count = 0;
  const normalized = sql.replace(/\bBETWEEN\s+(\d{6,})\s+AND\s+(\d{6,})\b/gi, (match, start: string, end: string) => {
    try {
      const startNs = BigInt(start);
      const endNs = BigInt(end);
      if (startNs <= endNs) return match;
      count += 1;
      return `BETWEEN ${end} AND ${start}`;
    } catch {
      return match;
    }
  });
  return { sql: normalized, count };
}

function normalizeGluedBooleanKeywordColumns(sql: string): { sql: string; count: number } {
  const knownColumns = [
    'arg_set_id',
    'blocked_function',
    'cpu',
    'dur',
    'end_ts',
    'frame_id',
    'id',
    'jank_type',
    'name',
    'pid',
    'process_name',
    'start_ts',
    'state',
    'thread_name',
    'tid',
    'track_id',
    'ts',
    'upid',
    'utid',
    'value',
  ].join('|');
  let count = 0;
  const normalized = sql.replace(
    new RegExp(`\\b(AND|OR)(${knownColumns})\\b(?=\\s*(?:=|!=|<>|<=|>=|<|>|IN\\b|LIKE\\b|GLOB\\b|BETWEEN\\b|IS\\b))`, 'gi'),
    (_match, op: string, column: string) => {
      count += 1;
      return `${op} ${column}`;
    },
  );
  return { sql: normalized, count };
}

function collectTableAliases(sql: string, tableName: string): Set<string> {
  const aliases = new Set<string>();

  const collectOneReference = (index: number): number | null => {
    const table = readSqlTableNameAfterFromOrJoin(sql, index);
    if (!table) return null;

    let end = table.end;
    const alias = readOptionalSqlAliasToken(sql, table.end);
    if (alias) end = alias.end;

    if (table.tableName.toLowerCase() === tableName.toLowerCase()) {
      aliases.add(tableName);
      if (alias) aliases.add(alias.value);
    }

    return end;
  };

  const collectCommaSeparatedReferences = (index: number): number => {
    let cursor = index;
    while (cursor < sql.length) {
      const end = collectOneReference(cursor);
      if (end === null) break;
      cursor = end;
      while (cursor < sql.length && /\s/.test(sql[cursor])) cursor += 1;
      if (sql[cursor] !== ',') break;
      cursor += 1;
    }
    return cursor;
  };

  let i = 0;
  while (i < sql.length) {
    const skipped = skipSqlIgnoredText(sql, i);
    if (skipped !== i) {
      i = skipped;
      continue;
    }
    if (!/[A-Za-z_]/.test(sql[i])) {
      i += 1;
      continue;
    }

    const wordStart = i;
    while (i < sql.length && /[A-Za-z0-9_]/.test(sql[i])) i += 1;
    const word = sql.slice(wordStart, i);
    if (/^FROM$/i.test(word)) {
      i = Math.max(i, collectCommaSeparatedReferences(i));
      continue;
    }
    if (/^JOIN$/i.test(word)) {
      const end = collectOneReference(i);
      if (end !== null) i = Math.max(i, end);
      continue;
    }
  }
  return aliases;
}

function previousSqlWord(maskedSql: string, index: number): string | null {
  let i = index - 1;
  while (i >= 0 && /\s/.test(maskedSql[i])) i -= 1;
  const end = i + 1;
  while (i >= 0 && /[A-Za-z0-9_]/.test(maskedSql[i])) i -= 1;
  if (end === i + 1) return null;
  return maskedSql.slice(i + 1, end);
}

function replaceBareThreadMainThreadReferences(sql: string): { sql: string; count: number } {
  const masked = maskSqlLiteralsCommentsAndQuotedIdentifiers(sql);
  const matcher = /\bmain_thread\b/gi;
  let match: RegExpExecArray | null;
  let rewritten = '';
  let lastIndex = 0;
  let count = 0;

  while ((match = matcher.exec(masked)) !== null) {
    const start = match.index;
    const end = matcher.lastIndex;
    if (masked[start - 1] === '.' || /^AS$/i.test(previousSqlWord(masked, start) ?? '')) {
      continue;
    }

    count += 1;
    rewritten += sql.slice(lastIndex, start);
    rewritten += 'is_main_thread';
    lastIndex = end;
  }

  if (count === 0) return { sql, count: 0 };
  rewritten += sql.slice(lastIndex);
  return { sql: rewritten, count };
}

function hasCteNamed(sql: string, name: string): boolean {
  const masked = maskSqlLiteralsCommentsAndQuotedIdentifiers(sql);
  return new RegExp(`\\bWITH\\b[\\s\\S]*\\b${escapeRegExp(name)}\\s+AS\\s*\\(`, 'i').test(masked);
}

function normalizeThreadMainThreadColumn(sql: string): { sql: string; rewrites: string[] } {
  if (hasCteNamed(sql, 'thread')) return { sql, rewrites: [] };

  let normalized = sql;
  const rewrites: string[] = [];
  const threadAliases = collectTableAliases(sql, 'thread');
  if (threadAliases.size === 0) return { sql, rewrites: [] };
  let changedQualified = 0;

  for (const alias of threadAliases) {
    const pattern = new RegExp(`\\b${escapeRegExp(alias)}\\.main_thread\\b`, 'gi');
    const result = replaceOutsideSqlLiteralsCommentsAndQuotedIdentifiers(normalized, pattern, () => {
      changedQualified += 1;
      return `${alias}.is_main_thread`;
    });
    normalized = result.sql;
  }

  let changedBare = 0;
  const bareResult = replaceBareThreadMainThreadReferences(normalized);
  changedBare += bareResult.count;
  normalized = bareResult.sql;

  if (changedQualified + changedBare > 0) {
    rewrites.push('rewrote thread main_thread column to is_main_thread; Perfetto thread table uses is_main_thread');
  }

  return { sql: normalized, rewrites };
}

function normalizeBareSliceColumnsAfterJoins(sql: string): { sql: string; rewrites: string[] } {
  const fromMatch = SLICE_FROM_WITH_ALIAS.exec(sql);
  if (!fromMatch) return { sql, rewrites: [] };
  if (!/\bJOIN\s+(?:thread|process|thread_track)\b/i.test(sql)) return { sql, rewrites: [] };

  const alias = fromMatch[1];
  const rewrites: string[] = [];
  let normalized = sql;
  let changedName = 0;
  normalized = normalized.replace(/\bSELECT\s+name\b/i, () => {
    changedName += 1;
    return `SELECT ${alias}.name AS slice_name`;
  });
  if (changedName > 0) {
    rewrites.push(`qualified bare slice name as ${alias}.name after joins with other name columns`);
  }

  let changedDur = 0;
  normalized = normalized.replace(/(?<!\.)\bdur\s*\/\s*1e6\b/gi, () => {
    changedDur += 1;
    return `${alias}.dur/1e6`;
  });
  normalized = normalized.replace(/\bORDER\s+BY\s+dur\b/gi, () => {
    changedDur += 1;
    return `ORDER BY ${alias}.dur`;
  });
  if (changedDur > 0) {
    rewrites.push(`qualified bare slice dur as ${alias}.dur after slice joins`);
  }

  return { sql: normalized, rewrites };
}

function normalizeThreadTrackProcessJoin(sql: string): { sql: string; rewrites: string[] } {
  const threadTrackMatch = /\bJOIN\s+thread_track\s+(?:AS\s+)?([A-Za-z_]\w*)\s+ON\s+([A-Za-z_]\w*)\.track_id\s*=\s*\1\.id\b/i.exec(sql);
  if (!threadTrackMatch) return { sql, rewrites: [] };

  const threadTrackAlias = threadTrackMatch[1];
  const processJoinPattern = new RegExp(
    `\\bJOIN\\s+process\\s+(?:AS\\s+)?([A-Za-z_]\\w*)\\s+ON\\s+${escapeRegExp(threadTrackAlias)}\\.upid\\s*=\\s*\\1\\.upid\\b`,
    'i',
  );
  const processJoinMatch = processJoinPattern.exec(sql);
  if (!processJoinMatch) return { sql, rewrites: [] };

  const processAlias = processJoinMatch[1];
  const threadAlias = hasSqlAlias(sql, 'th') ? 'thread_ref' : 'th';
  const rewrites: string[] = [];
  let normalized = sql.replace(
    processJoinPattern,
    `JOIN thread ${threadAlias} ON ${threadTrackAlias}.utid = ${threadAlias}.utid\nJOIN process ${processAlias} ON ${threadAlias}.upid = ${processAlias}.upid`,
  );

  const threadNamePattern = new RegExp(
    `\\b${escapeRegExp(threadTrackAlias)}\\.name\\s+AS\\s+thread_name\\b`,
    'gi',
  );
  normalized = normalized.replace(threadNamePattern, `${threadAlias}.name AS thread_name`);
  rewrites.push(
    `joined thread between thread_track ${threadTrackAlias} and process ${processAlias}; thread_track exposes utid but not upid`,
  );

  return { sql: normalized, rewrites };
}

function extractRequestedFrameIds(sql: string): string[] {
  const ids: string[] = [];
  const seen = new Set<string>();
  const frameIdPattern = /\b(?:SELECT|UNION(?:\s+ALL)?\s+SELECT)\s+'([^']+)'\s+(?:AS\s+frame_id\b)?/gi;
  let match: RegExpExecArray | null;
  while ((match = frameIdPattern.exec(sql)) !== null) {
    const id = match[1]?.trim();
    if (!id || seen.has(id)) continue;
    seen.add(id);
    ids.push(id);
  }
  return ids;
}

function quoteSqlString(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

function extractFrameIdPredicates(sql: string): string[] {
  const ids: string[] = [];
  const seen = new Set<string>();
  const add = (value: string | undefined) => {
    const id = value?.trim().replace(/^['"]|['"]$/g, '');
    if (!id || seen.has(id)) return;
    seen.add(id);
    ids.push(id);
  };

  const equalityPattern = /\bframe_id\s*=\s*(['"]?)([A-Za-z0-9_.:-]+)\1/gi;
  let match: RegExpExecArray | null;
  while ((match = equalityPattern.exec(sql)) !== null) {
    add(match[2]);
  }

  const inPattern = /\bframe_id\s+IN\s*\(([^)]*)\)/gi;
  while ((match = inPattern.exec(sql)) !== null) {
    for (const raw of match[1].split(',')) {
      add(raw);
    }
  }

  return ids;
}

function normalizeUnsupportedIntrinsicBatchFrameRootCauseLookup(sql: string): { sql: string; rewrites: string[] } {
  if (collectTableAliases(sql, '__intrinsic_batch_frame_root_cause').size === 0) return { sql, rewrites: [] };

  const frameIds = extractFrameIdPredicates(sql);
  const requestedFrames = frameIds.length > 0
    ? frameIds
      .map((frameId, index) => `${index === 0 ? 'SELECT' : 'UNION ALL SELECT'} ${quoteSqlString(frameId)} AS frame_id`)
      .join('\n  ')
    : 'SELECT frame_id FROM frame_lookup WHERE COALESCE(jank_type, \'None\') != \'None\' LIMIT 50';

  return {
    sql: `WITH frame_lookup AS (
  SELECT
    CAST(COALESCE(a.display_frame_token, a.surface_frame_token, a.id) AS TEXT) AS frame_id,
    a.ts AS start_ts,
    a.dur AS dur,
    a.jank_type AS jank_type
  FROM actual_frame_timeline_slice a
),
requested_frames AS (
  ${requestedFrames}
)
SELECT
  r.frame_id,
  CASE WHEN f.start_ts IS NULL THEN NULL ELSE printf('%d', f.start_ts) END AS start_ts,
  CASE WHEN f.start_ts IS NULL THEN NULL ELSE printf('%d', f.start_ts + f.dur) END AS end_ts,
  ROUND(f.dur / 1e6, 2) AS dur_ms,
  f.jank_type AS jank_type,
  CASE
    WHEN f.jank_type GLOB '*Self Jank*'
      OR f.jank_type GLOB '*App Deadline Missed*'
      OR f.jank_type GLOB '*App Resynced Jitter*' THEN 'APP'
    WHEN f.jank_type GLOB '*SurfaceFlinger*' THEN 'SF'
    WHEN f.jank_type GLOB '*Buffer Stuffing*' THEN 'BUFFER_STUFFING'
    WHEN f.jank_type GLOB '*Prediction Error*'
      OR f.jank_type GLOB '*Display HAL*' THEN 'SF'
    WHEN f.jank_type = 'None' OR f.jank_type IS NULL THEN 'HIDDEN'
    ELSE 'UNKNOWN'
  END AS jank_responsibility,
  CAST(NULL AS TEXT) AS reason_code,
  CAST(NULL AS TEXT) AS top_slice_name,
  CAST(NULL AS REAL) AS top_slice_ms,
  CAST(NULL AS REAL) AS main_q4b_pct,
  'batch_frame_root_cause is a skill artifact; use fetch_artifact for derived reason_code/top_slice/quadrant fields' AS source_note
FROM requested_frames r
LEFT JOIN frame_lookup f USING(frame_id)
ORDER BY f.dur DESC`,
    rewrites: [
      'replaced unsupported __intrinsic_batch_frame_root_cause lookup with a safe FrameTimeline lookup; batch_frame_root_cause is a skill artifact and derived fields require fetch_artifact',
    ],
  };
}

function normalizeUnsupportedActualFrameTimelineFrequencyLookup(sql: string): { sql: string; rewrites: string[] } {
  if (!/\bactual_frame_timeline_slice\b/i.test(sql)) return { sql, rewrites: [] };
  if (!/\bbig_avg_freq_mhz\b/i.test(sql) && !/\bdevice_peak_freq_mhz\b/i.test(sql)) return { sql, rewrites: [] };
  if (!/\bFROM\s*\(\s*SELECT\s+'[^']+'\s+AS\s+frame_id\b/i.test(sql)) return { sql, rewrites: [] };

  const frameIds = extractRequestedFrameIds(sql);
  if (frameIds.length === 0) return { sql, rewrites: [] };

  const requestedFrames = frameIds
    .map((frameId, index) => `${index === 0 ? 'SELECT' : 'UNION ALL SELECT'} ${quoteSqlString(frameId)} AS frame_id`)
    .join('\n  ');

  return {
    sql: `WITH requested_frames AS (
  ${requestedFrames}
)
SELECT
  r.frame_id,
  ROUND(a.dur / 1e6, 2) AS dur_ms,
  CAST(NULL AS REAL) AS big_avg_freq_mhz,
  CAST(NULL AS REAL) AS device_peak_freq_mhz,
  CAST(NULL AS REAL) AS freq_ratio,
  CAST(NULL AS TEXT) AS cpu_freq_clusters_json
FROM requested_frames r
LEFT JOIN actual_frame_timeline_slice a
  ON CAST(a.id AS TEXT) = r.frame_id
  OR CAST(a.display_frame_token AS TEXT) = r.frame_id
  OR a.name = r.frame_id
ORDER BY a.dur DESC`,
    rewrites: [
      'replaced unsupported actual_frame_timeline_slice frequency lookup with a safe frame duration lookup; frequency columns are skill-derived, not FrameTimeline table columns',
    ],
  };
}

/**
 * Normalize high-confidence Perfetto SQL footguns before trace_processor sees
 * them. This is intentionally conservative: rewrite only when the dropped
 * table alias is not referenced by the rest of the query.
 */
export function normalizeRawSql(sql: string): RawSqlNormalizationResult {
  if (!sql || typeof sql !== 'string') return { sql, rewrites: [] };

  let normalized = sql;
  const rewrites: string[] = [];
  const threadSliceAlias = findThreadSliceAlias(normalized);

  const reversedBetween = normalizeReversedLiteralBetween(normalized);
  if (reversedBetween.count > 0) {
    normalized = reversedBetween.sql;
    rewrites.push('swapped reversed numeric BETWEEN bounds so the time range is start <= end');
  }

  const gluedBooleanColumns = normalizeGluedBooleanKeywordColumns(normalized);
  if (gluedBooleanColumns.count > 0) {
    normalized = gluedBooleanColumns.sql;
    rewrites.push('inserted missing whitespace between boolean operators and known Perfetto columns');
  }

  const threadMainThreadColumn = normalizeThreadMainThreadColumn(normalized);
  if (threadMainThreadColumn.rewrites.length > 0) {
    normalized = threadMainThreadColumn.sql;
    rewrites.push(...threadMainThreadColumn.rewrites);
  }

  const sliceColumns = normalizeBareSliceColumnsAfterJoins(normalized);
  if (sliceColumns.rewrites.length > 0) {
    normalized = sliceColumns.sql;
    rewrites.push(...sliceColumns.rewrites);
  }

  const threadTrackProcessJoin = normalizeThreadTrackProcessJoin(normalized);
  if (threadTrackProcessJoin.rewrites.length > 0) {
    normalized = threadTrackProcessJoin.sql;
    rewrites.push(...threadTrackProcessJoin.rewrites);
  }

  const intrinsicBatchFrameRootCauseLookup = normalizeUnsupportedIntrinsicBatchFrameRootCauseLookup(normalized);
  if (intrinsicBatchFrameRootCauseLookup.rewrites.length > 0) {
    normalized = intrinsicBatchFrameRootCauseLookup.sql;
    rewrites.push(...intrinsicBatchFrameRootCauseLookup.rewrites);
  }

  const actualFrameFrequencyLookup = normalizeUnsupportedActualFrameTimelineFrequencyLookup(normalized);
  if (actualFrameFrequencyLookup.rewrites.length > 0) {
    normalized = actualFrameFrequencyLookup.sql;
    rewrites.push(...actualFrameFrequencyLookup.rewrites);
  }

  if (/\bFROM\s+thread_slice\b/i.test(normalized)) {
    const threadSliceBase = threadSliceAlias;
    if (threadSliceAlias !== 't' && !hasSqlAlias(normalized, 't')) {
      for (const [sourceColumn, targetColumn] of [
        ['name', 'thread_name'],
        ['is_main_thread', 'is_main_thread'],
        ['tid', 'tid'],
        ['utid', 'utid'],
      ]) {
        const result = replaceDanglingAliasColumn(
          normalized,
          't',
          sourceColumn,
          columnRef(threadSliceBase, targetColumn),
        );
        if (result.count > 0) {
          normalized = result.sql;
          rewrites.push(
            `rewrote dangling t.${sourceColumn} reference to thread_slice ${targetColumn}; thread_slice already exposes thread columns`,
          );
        }
      }
    }
    if (threadSliceAlias !== 'p' && !hasSqlAlias(normalized, 'p')) {
      const result = replaceDanglingAliasColumn(
        normalized,
        'p',
        'name',
        columnRef(threadSliceBase, 'process_name'),
      );
      if (result.count > 0) {
        normalized = result.sql;
        rewrites.push(
          'rewrote dangling p.name reference to thread_slice process_name; thread_slice already exposes process columns',
        );
      }
    }
  }

  if (/\bactual_frame_timeline_slice\b/i.test(normalized)) {
    const threadUsingUtidJoin = /\b(?:INNER\s+|LEFT(?:\s+OUTER)?\s+|CROSS\s+)?JOIN\s+thread(?:\s+(?:AS\s+)?([A-Za-z_]\w*))?\s+USING\s*\(\s*utid\s*\)/gi;
    normalized = normalized.replace(threadUsingUtidJoin, (match: string, alias: string | undefined, offset: number, full: string) => {
      const withoutJoin = full.slice(0, offset) + full.slice(offset + match.length);
      const referencePattern = alias
        ? new RegExp(`\\b${escapeRegExp(alias)}\\.`, 'i')
        : /\bthread\./i;
      if (referencePattern.test(withoutJoin)) return match;

      rewrites.push(
        'removed JOIN thread USING(utid) from actual_frame_timeline_slice query; FrameTimeline rows expose upid but not utid',
      );
      return '';
    });
  }

  if (
    /\bFROM\s+thread_slice\b/i.test(normalized) &&
    /\bself_dur\b/i.test(normalized) &&
    !/\b(?:FROM|JOIN)\s+slice_self_dur\b/i.test(normalized)
  ) {
    normalized = normalized.replace(THREAD_SLICE_FROM, match => {
      rewrites.push(
        'joined slice_self_dur for thread_slice self_dur lookup; thread_slice does not expose self_dur directly',
      );
      return `${match}\nLEFT JOIN slice_self_dur USING(id)`;
    });
  }

  return { sql: normalized, rewrites };
}
