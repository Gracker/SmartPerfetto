// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import * as fs from 'fs';
import * as path from 'path';

import {
  injectStdlibIncludes,
  _getSymbolIndexForTesting,
} from '../sqlIncludeInjector';

describe('sqlIncludeInjector - happy paths', () => {
  it('injects slices.self_dur when SQL references slice_self_dur', () => {
    const { sql, injected } = injectStdlibIncludes(
      'SELECT id, self_dur FROM slice_self_dur ORDER BY self_dur DESC LIMIT 10'
    );
    expect(injected).toEqual(['slices.self_dur']);
    expect(sql.startsWith('INCLUDE PERFETTO MODULE slices.self_dur;\n')).toBe(true);
  });

  it('injects linux.cpu.frequency when SQL references cpu_frequency_counters', () => {
    const { sql, injected } = injectStdlibIncludes(
      'SELECT cpu, AVG(freq) FROM cpu_frequency_counters GROUP BY cpu'
    );
    expect(injected).toEqual(['linux.cpu.frequency']);
    expect(sql).toMatch(/^INCLUDE PERFETTO MODULE linux\.cpu\.frequency;/);
  });

  it('injects multiple modules in alphabetical order', () => {
    const { injected } = injectStdlibIncludes(
      'SELECT * FROM slice_self_dur s JOIN cpu_frequency_counters c ON s.id = c.cpu'
    );
    expect(injected).toEqual(['linux.cpu.frequency', 'slices.self_dur']);
  });
});

describe('sqlIncludeInjector - idempotency & dedup', () => {
  it('does not duplicate INCLUDE if already present', () => {
    const { sql, injected } = injectStdlibIncludes(
      'INCLUDE PERFETTO MODULE slices.self_dur;\nSELECT * FROM slice_self_dur'
    );
    expect(injected).toEqual([]);
    expect(sql).toBe('INCLUDE PERFETTO MODULE slices.self_dur;\nSELECT * FROM slice_self_dur');
  });

  it('handles INCLUDE statement with extra whitespace and capitalization', () => {
    const { injected } = injectStdlibIncludes(
      'include  perfetto   module   slices.self_dur ;\nSELECT * FROM slice_self_dur'
    );
    expect(injected).toEqual([]);
  });
});

describe('sqlIncludeInjector - built-ins are never injected', () => {
  it.each([
    ['slice', 'SELECT * FROM slice WHERE dur > 1000'],
    ['thread', 'SELECT * FROM thread WHERE name = "RenderThread"'],
    ['process', 'SELECT * FROM process WHERE name LIKE "com.%"'],
    ['counter', 'SELECT * FROM counter LIMIT 100'],
    ['thread_state', 'SELECT * FROM thread_state WHERE state = "Running"'],
    ['actual_frame_timeline_slice', 'SELECT * FROM actual_frame_timeline_slice'],
    ['expected_frame_timeline_slice', 'SELECT * FROM expected_frame_timeline_slice'],
    ['args', 'SELECT * FROM args LIMIT 1'],
    ['stack_profile_callsite', 'SELECT * FROM stack_profile_callsite'],
  ])('skips builtin %s', (_, sql) => {
    expect(injectStdlibIncludes(sql).injected).toEqual([]);
  });
});

describe('sqlIncludeInjector - quoted identifiers', () => {
  it('injects when the table name is a double-quoted identifier', () => {
    const { injected } = injectStdlibIncludes(
      'SELECT * FROM "slice_self_dur" ORDER BY self_dur DESC LIMIT 5',
    );
    expect(injected).toEqual(['slices.self_dur']);
  });
});

describe('sqlIncludeInjector - macros', () => {
  it('injects when a stdlib macro is invoked via name!()', () => {
    const { injected } = injectStdlibIncludes(
      'SELECT * FROM counter_leading_intervals!(counter, value)',
    );
    expect(injected).toEqual(['counters.intervals']);
  });

  it('does not match the inequality operator !=', () => {
    const { injected } = injectStdlibIncludes(
      'SELECT * FROM slice WHERE dur != 0 AND name IS NOT NULL',
    );
    expect(injected).toEqual([]);
  });
});

describe('sqlIncludeInjector - comma joins', () => {
  it('extracts all tables in a comma-separated FROM clause', () => {
    const { injected } = injectStdlibIncludes(
      'SELECT * FROM slice_self_dur s, cpu_frequency_counters c WHERE s.id = c.cpu'
    );
    expect(injected.sort()).toEqual(['linux.cpu.frequency', 'slices.self_dur']);
  });
});

describe('sqlIncludeInjector - function calls', () => {
  it('injects when a stdlib function is invoked', () => {
    const { injected } = injectStdlibIncludes(
      'SELECT * FROM cpu_thread_utilization_in_interval(0, 1000000000)'
    );
    expect(injected.length).toBeGreaterThan(0);
    expect(injected[0]).toMatch(/^linux\.cpu\.utilization\./);
  });

  it('does not inject for SQLite built-in functions', () => {
    const { injected } = injectStdlibIncludes(
      'SELECT COUNT(*), SUM(dur), AVG(dur), MAX(dur), MIN(dur) FROM slice'
    );
    expect(injected).toEqual([]);
  });
});

describe('sqlIncludeInjector - comment & string masking', () => {
  it('ignores stdlib names inside line comments', () => {
    const { injected } = injectStdlibIncludes(
      '-- FROM slice_self_dur\nSELECT * FROM slice'
    );
    expect(injected).toEqual([]);
  });

  it('ignores stdlib names inside block comments', () => {
    const { injected } = injectStdlibIncludes(
      '/* FROM slice_self_dur */ SELECT * FROM slice'
    );
    expect(injected).toEqual([]);
  });

  it('ignores stdlib names inside string literals', () => {
    const { injected } = injectStdlibIncludes(
      "SELECT * FROM slice WHERE name = 'slice_self_dur'"
    );
    expect(injected).toEqual([]);
  });

  it('handles SQL escaped quotes within strings', () => {
    const { injected } = injectStdlibIncludes(
      "SELECT * FROM slice WHERE name = 'it''s slice_self_dur time'"
    );
    expect(injected).toEqual([]);
  });

  it('still injects when references appear after a comment', () => {
    const { injected } = injectStdlibIncludes(
      '-- this query computes self_dur\nSELECT * FROM slice_self_dur'
    );
    expect(injected).toEqual(['slices.self_dur']);
  });
});

describe('sqlIncludeInjector - CTE shadowing', () => {
  it('does not inject for unknown identifiers (CTE names)', () => {
    const { injected } = injectStdlibIncludes(
      'WITH heavy AS (SELECT * FROM slice WHERE dur > 1e9) SELECT * FROM heavy'
    );
    expect(injected).toEqual([]);
  });

  it('still injects when CTE references a stdlib table', () => {
    const { injected } = injectStdlibIncludes(
      'WITH x AS (SELECT * FROM slice_self_dur) SELECT * FROM x'
    );
    expect(injected).toEqual(['slices.self_dur']);
  });
});

describe('sqlIncludeInjector - Tier-0 race safety', () => {
  it('injects android.frames.timeline even though it is a Tier-0 preload (race-safe)', () => {
    const { injected } = injectStdlibIncludes('SELECT * FROM android_frames LIMIT 10');
    // Tier-0 preload is fire-and-forget; the first raw query may arrive
    // before the preload completes, so the injector intentionally does NOT
    // skip Tier-0 modules. Repeat INCLUDE is idempotent for trace_processor.
    expect(injected).toEqual(['android.frames.timeline']);
  });
});

describe('sqlIncludeInjector - completeness gate', () => {
  // Bidirectional: every backtick-fenced lowercase identifier inside the
  // "Perfetto SQL Stdlib" section of prompt-methodology.template.md must
  // resolve to either a prelude builtin (no INCLUDE needed) or a module
  // path. Auto-extracts both directions, so the gate self-maintains as
  // the prompt evolves.
  const METHODOLOGY_PATH = path.resolve(
    __dirname,
    '../../../strategies/prompt-methodology.template.md',
  );
  const SECTION_HEADER = '### Perfetto SQL Stdlib';
  const SECTION_FOOTER = '### SQL 错误自纠正';

  // Identifiers in the prompt that are deliberately not stdlib symbols
  // (e.g. MCP tool names, frontmatter literals). Listed explicitly so the
  // gate fails loudly on genuinely new advertised names.
  const NON_STDLIB_NAMES = new Set<string>([
    'list_stdlib_modules',
    'execute_sql', 'execute_sql_on', 'lookup_sql_schema',
    'invoke_skill', 'list_skills', 'query_perfetto_source',
    'cpufreq',
  ]);

  const extractAdvertisedNames = () => {
    const md = fs.readFileSync(METHODOLOGY_PATH, 'utf-8');
    const start = md.indexOf(SECTION_HEADER);
    const end = md.indexOf(SECTION_FOOTER, start);
    if (start < 0 || end < 0) {
      throw new Error(
        `Section markers not found in ${METHODOLOGY_PATH}. ` +
        `Looking for "${SECTION_HEADER}" -> "${SECTION_FOOTER}".`,
      );
    }
    const section = md.slice(start, end);
    const out = new Set<string>();
    // Backtick-fenced lowercase identifier, optionally followed by
    // `(args)` (function/macro form) or `.column` (column reference).
    const re = /`([a-z][a-z0-9_]+)(?:\([^`]*\)|\.\w+)?`/g;
    for (const m of section.matchAll(re)) {
      const name = m[1];
      if (!NON_STDLIB_NAMES.has(name)) out.add(name);
    }
    return out;
  };

  it('every advertised stdlib name resolves to a builtin or stdlib module', () => {
    const advertised = extractAdvertisedNames();
    expect(advertised.size).toBeGreaterThan(20); // sanity: section non-empty
    const { tableToModule, builtins } = _getSymbolIndexForTesting();
    const missing: string[] = [];
    for (const name of advertised) {
      if (builtins.has(name)) continue;
      if (tableToModule.has(name)) continue;
      missing.push(name);
    }
    if (missing.length) {
      throw new Error(
        `Methodology drift: ${missing.length}/${advertised.size} stdlib ` +
        `name(s) advertised in prompt-methodology.template.md cannot be ` +
        `resolved by the injector:\n` +
        missing.map(n => `  - ${n}`).join('\n') +
        `\n\nEither (a) the prompt advertises a name with a typo, ` +
        `(b) the perfetto submodule no longer ships this symbol, or ` +
        `(c) the name is intentionally non-stdlib and should be added ` +
        `to NON_STDLIB_NAMES in this test.`,
      );
    }
  });
});
