// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import * as fs from 'fs';
import * as path from 'path';

import {
  injectStdlibIncludes,
  _getSymbolIndexForTesting,
} from '../sqlIncludeInjector';
import {analyzeSqlStdlibDependencies} from '../../services/sqlStdlibDependencyAnalyzer';

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

  it('does not inject when a function-like stdlib name is only double-quoted text', () => {
    const { injected } = injectStdlibIncludes(
      'SELECT "cpu_thread_utilization_in_interval(0, 1)" AS literalish FROM slice',
    );
    expect(injected).toEqual([]);
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

  it('continues scanning comma joins after a table-valued function', () => {
    const { injected } = injectStdlibIncludes(
      'SELECT * FROM cpu_thread_utilization_in_interval(0, 1000000000) util, slice_self_dur s',
    );
    expect(injected).toEqual(expect.arrayContaining(['slices.self_dur']));
    expect(injected.some(module => module.startsWith('linux.cpu.utilization.'))).toBe(true);
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

// A stdlib view is invisible to schema introspection until its module is
// included, so an existence check the model writes itself used to return zero
// rows and read as "this trace has no such table". Only an exact string
// literal names one symbol; LIKE/GLOB patterns stay unresolved by design.
describe('sqlIncludeInjector - schema introspection by exact literal', () => {
  it('injects for pragma_table_info / pragma_table_xinfo literals', () => {
    expect(injectStdlibIncludes(
      "SELECT name FROM pragma_table_info('android_monitor_contention')",
    ).injected).toEqual(['android.monitor_contention']);
    expect(injectStdlibIncludes(
      "SELECT name, type FROM pragma_table_xinfo( 'ANDROID_BINDER_TXNS' )",
    ).injected).toEqual(['android.binder']);
  });

  it('injects for the PRAGMA table_info statement form', () => {
    expect(injectStdlibIncludes('PRAGMA table_info(android_input_events)').injected)
      .toEqual(['android.input']);
    expect(injectStdlibIncludes("PRAGMA main.table_info('android_input_events');").injected)
      .toEqual(['android.input']);
  });

  it('injects for sqlite_master / sqlite_schema name predicates', () => {
    expect(injectStdlibIncludes(
      "SELECT 1 FROM sqlite_master WHERE type IN ('table', 'view') AND name = 'android_monitor_contention'",
    ).injected).toEqual(['android.monitor_contention']);
    expect(injectStdlibIncludes(
      "SELECT name FROM sqlite_schema WHERE tbl_name IN ('android_input_events', 'slice', 'not_a_table')",
    ).injected).toEqual(['android.input']);
  });

  it('does not resolve GLOB / LIKE patterns or literals outside a schema lookup', () => {
    expect(injectStdlibIncludes(
      "SELECT name FROM sqlite_master WHERE name GLOB 'android_monitor*'",
    ).injected).toEqual([]);
    expect(injectStdlibIncludes(
      "SELECT name FROM sqlite_master WHERE name LIKE 'android_monitor_contention%'",
    ).injected).toEqual([]);
    expect(injectStdlibIncludes(
      "SELECT * FROM slice WHERE name = 'android_monitor_contention'",
    ).injected).toEqual([]);
    expect(injectStdlibIncludes(
      "-- pragma_table_info('android_monitor_contention')\nSELECT 1",
    ).injected).toEqual([]);
  });

  it('keeps Skill-style dependency analysis free of introspection references', () => {
    const analysis = analyzeSqlStdlibDependencies(
      "SELECT 1 FROM sqlite_master WHERE name = 'android_monitor_contention'",
    );
    expect(analysis.dependencies).toEqual([]);
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
  // Bidirectional: every backtick-fenced lowercase identifier advertised as a
  // SQL/stdlib helper in prompt surfaces must resolve to either a prelude
  // builtin (no INCLUDE needed) or a module path. Auto-extracts both
  // directions, so the gate self-maintains as strategy markdown evolves.
  const STRATEGIES_DIR = path.resolve(__dirname, '../../../strategies');
  const SQL_GUIDANCE_PATH = path.resolve(
    STRATEGIES_DIR,
    'prompt-sql-evidence-guidance.template.md',
  );
  // Identifiers in the prompt that are deliberately not stdlib symbols
  // (e.g. MCP tool names, frontmatter literals). Listed explicitly so the
  // gate fails loudly on genuinely new advertised names.
  const NON_STDLIB_NAMES = new Set<string>([
    'list_stdlib_modules',
    'execute_sql', 'execute_sql_on', 'fetch_artifact', 'lookup_sql_schema',
    'get_comparison_context', 'compare_skill',
    'invoke_skill', 'list_skills', 'query_perfetto_source',
    'ts', 'dur', 'name',
    'cpufreq',
    'thread_name', 'process_name',
    'unknown', 'awake',
    'android_frame_timeline_metric_per_process',
    'weighted_missed_frames',
    'weighted_missed_app_frames',
    'weighted_missed_sf_frames',
    'batch_frame_root_cause',
    'big_avg_freq_mhz',
    'cpu_freq_clusters_json',
    'device_peak_freq_mhz',
    'page_fault',
    // Strategy/skill vocabulary that is intentionally not stdlib: slice-name
    // anchors used by the startup fallback, and wakeup-chain output columns.
    'inflate', 'wait_ms', 'run_ms_in_wait',
  ]);

  const extractSqlGuidance = () => [SQL_GUIDANCE_PATH,
    path.join(STRATEGIES_DIR, 'knowledge-perfetto-sql.template.md')]
    .map(file => fs.readFileSync(file, 'utf-8')).join('\n');

  const extractStrategySqlRecommendationText = () => {
    return fs
      .readdirSync(STRATEGIES_DIR)
      .filter(file => file.endsWith('.strategy.md'))
      .map(file => fs.readFileSync(path.join(STRATEGIES_DIR, file), 'utf-8'))
      .flatMap(md => md.split(/\r?\n/))
      .filter(line => line.includes('execute_sql') && line.includes('`'))
      .join('\n');
  };

  const extractAdvertisedNames = () => {
    const promptText = [
      extractSqlGuidance(),
      extractStrategySqlRecommendationText(),
    ].join('\n');
    const out = new Set<string>();
    // Backtick-fenced lowercase identifier, optionally followed by
    // `(args)` / `!(args)` (function/macro form) or `.column`.
    const re = /`([a-z][a-z0-9_]+)(?:!?\([^`]*\)|\.\w+)?`/g;
    for (const m of promptText.matchAll(re)) {
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
        `SQL guidance drift: ${missing.length}/${advertised.size} stdlib ` +
        `name(s) advertised in strategy prompt surfaces cannot be ` +
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
