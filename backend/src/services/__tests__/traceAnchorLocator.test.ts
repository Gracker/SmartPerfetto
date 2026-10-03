// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import {afterAll, beforeAll, describe, expect, it} from '@jest/globals';

import {CodebaseRegistry} from '../codebase/codebaseRegistry';
import {OnDemandSourceAccessService} from '../codebase/onDemandSourceAccess';
import {
  loadSourceAnchorNormalization,
  locateTraceAnchor,
  parseSourceAnchorNormalization,
  planTraceAnchorSearch,
  TRACE_ANCHOR_SEARCH_OPTIONS,
  type TraceAnchorKind,
} from '../codebase/traceAnchorLocator';

const scope = {tenantId: 'tenant-a', workspaceId: 'workspace-a', userId: 'user-a'};
const policy = loadSourceAnchorNormalization();

let tmpDir: string;
let codebaseId: string;
let access: OnDemandSourceAccessService;

function write(relativePath: string, lines: string[]): void {
  const file = path.join(tmpDir, 'repo', relativePath);
  fs.mkdirSync(path.dirname(file), {recursive: true});
  fs.writeFileSync(file, `${lines.join('\n')}\n`);
}

beforeAll(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'trace-anchor-locator-'));
  write('app/src/main/java/com/demo/app/startup/StartupHooks.kt', [
    'package com.demo.app.startup',
    'import android.os.Trace',
    'object StartupHooks {',
    '  const val INIT_SECTION = "App#initSdk"',
    '  fun init() {',
    '    Trace.beginSection(INIT_SECTION)',
    '    Trace.endSection()',
    '  }',
    '  fun chain(chainId: Int) {',
    '    Trace.beginSection("MQ_Chain_${chainId}_Step")',
    '  }',
    '  fun worker() {',
    '    thread(name = "DemoBackgroundLoader") { }',
    '  }',
    '  fun config() {',
    '    android.os.Trace.beginSection("LoadConfig")',
    '  }',
    '}',
  ]);
  // A trace section that merely contains a thread name must not outrank where the thread is named.
  write('app/src/main/java/com/demo/app/work/Ticker.kt', [
    'package com.demo.app.work',
    'fun tick() { Trace.beginSection("DemoBackgroundLoader_tick") }',
  ]);
  write('app/src/main/java/com/demo/app/feed/FeedAdapter.kt', [
    'package com.demo.app.feed',
    'class FeedAdapter {',
    '  override fun onBindViewHolder(holder: Holder, position: Int) {',
    '  }',
    '}',
  ]);
  write('lib/src/main/java/com/other/lib/ConfigLoader.kt', [
    'package com.other.lib',
    'object ConfigLoader {',
    '  fun load() {',
    '    android.os.Trace.beginSection("LoadConfig")',
    '  }',
    '}',
  ]);
  write('app/src/main/cpp/renderer.cpp', [
    '#include "renderer.h"',
    'void Renderer::drawFrame(int frame) {',
    '  drawFrame_impl(frame);',
    '}',
  ]);
  const registry = new CodebaseRegistry(path.join(tmpDir, 'registry.json'));
  codebaseId = registry.register({kind: 'app_source', displayName: 'Demo', rootPath: path.join(tmpDir, 'repo'),
    rootAuthorization: 'native_picker', sendToProvider: true, ...scope}).codebaseId;
  access = new OnDemandSourceAccessService({registry});
});

afterAll(() => {
  fs.rmSync(tmpDir, {recursive: true, force: true});
});

function locate(anchor: string, kind: TraceAnchorKind, processName?: string, mode: 'provider_send' | 'metadata_only' = 'provider_send') {
  return locateTraceAnchor({anchor, kind, codebaseId, processName, maxResults: 5, policy,
    search: query => access.search({codebaseId, scope, query, mode, ...TRACE_ANCHOR_SEARCH_OPTIONS})});
}

describe('locateTraceAnchor', () => {
  it('follows a constant from its definition to the trace call that uses it', async () => {
    const result = await locate('App#initSdk', 'slice');
    expect(result.success).toBe(true);
    expect(result.matches[0]).toMatchObject({matchedBy: 'trace_call', viaConstant: true,
      filePath: 'app/src/main/java/com/demo/app/startup/StartupHooks.kt'});
    expect(result.matches[0]!.matchLines).toEqual([6]);
    expect(result.matches.some(match => match.matchedBy === 'constant_definition')).toBe(true);
    expect(result.normalizations).toContain('constant_hop');
    expect(result.searchesRun).toBeLessThanOrEqual(policy.maxInternalSearches);
  });

  it('ranks the same way under metadata_only and delivers no line text', async () => {
    const result = await locate('MQ_Chain_42_Step', 'slice', undefined, 'metadata_only');
    expect(result.matches[0]).toMatchObject({matchedBy: 'trace_call', matchLines: [10]});
    for (const match of result.matches) {
      expect(match).not.toHaveProperty('text');
      expect(match).not.toHaveProperty('matchLineTexts');
    }
  });

  it('matches a name whose number was built at run time', async () => {
    const result = await locate('MQ_Chain_42_Step', 'slice');
    expect(result.normalizations).toContain('templated_number');
    expect(result.matches[0]).toMatchObject({matchedBy: 'trace_call', filePath: expect.stringContaining('StartupHooks.kt')});
    expect(result.matches[0]!.matchLines).toEqual([10]);
  });

  it('finds the thread that a 15-character kernel name truncates', async () => {
    const result = await locate('DemoBackgroundL', 'thread');
    expect(result.normalizations).toContain('thread_name_prefix');
    expect(result.matches[0]).toMatchObject({matchedBy: 'thread_creation'});
    expect(result.matches[0]!.matchLines).toEqual([13]);
  });

  it('marks a framework slice and searches only the app methods that override its hook', async () => {
    const result = await locate('RV OnBindView', 'slice');
    expect(result.framework).toEqual({implementation: 'aosp', overrides: ['onBindViewHolder']});
    expect(result.matches[0]).toMatchObject({matchedBy: 'framework_override',
      filePath: 'app/src/main/java/com/demo/app/feed/FeedAdapter.kt'});
    expect(planTraceAnchorSearch({anchor: 'Choreographer#doFrame', kind: 'slice'}, policy))
      .toMatchObject({queries: [], framework: {implementation: 'aosp', overrides: []}});
  });

  it('reports a name two modules emit as ambiguous unless the traced process picks one', async () => {
    const unscoped = await locate('LoadConfig', 'slice');
    expect(unscoped.ambiguous).toBe(true);
    expect(unscoped.matches.filter(match => match.matchedBy === 'trace_call')).toHaveLength(2);

    const scoped = await locate('LoadConfig', 'slice', 'com.demo.app:background');
    expect(scoped.ambiguous).toBeUndefined();
    expect(scoped.matches[0]!.filePath).toBe('app/src/main/java/com/demo/app/startup/StartupHooks.kt');
  });

  it('reads a native frame as its method and ranks the declaration first', async () => {
    const result = await locate('libdemo.so!Renderer::drawFrame(int) + 0x24', 'native_frame');
    expect(result.normalizations).toContain('native_frame_method');
    expect(result.matches[0]).toMatchObject({matchedBy: 'method_declaration', filePath: 'app/src/main/cpp/renderer.cpp'});
    expect(result.matches[0]!.matchLines).toEqual([2]);
  });

  it('answers a refused first search with the refusal and searches nothing more', async () => {
    let searches = 0;
    const result = await locateTraceAnchor({anchor: 'LoadConfig', kind: 'slice', codebaseId, maxResults: 5, policy,
      search: async () => {
        searches++;
        return {success: false, codebaseId, matches: [], truncated: false, unsupportedReason: 'no_send_to_provider_consent'};
      }});
    expect(result).toMatchObject({success: false, unsupportedReason: 'no_send_to_provider_consent', matches: []});
    expect(searches).toBe(1);
  });

  it('never claims absence, and passes on an incomplete internal search', async () => {
    const empty = await locate('NoSuchSectionAnywhere', 'slice');
    expect(empty).toMatchObject({success: true, matches: []});
    expect(empty).not.toHaveProperty('coverageComplete');

    const incomplete = await locateTraceAnchor({anchor: 'LoadConfig', kind: 'slice', codebaseId, maxResults: 5, policy,
      search: async () => ({success: true, codebaseId, matches: [], truncated: true, coverageComplete: false,
        searchIncompleteReason: 'time_budget'})});
    expect(incomplete).toMatchObject({coverageComplete: false, searchIncompleteReason: 'time_budget'});
  });
});

describe('source-anchor-normalization policy', () => {
  const base = () => ({
    schema_version: 'source_anchor_normalization@1', max_internal_searches: 4, min_literal_chars: 3,
    thread_name_max_chars: 15, trace_call_patterns: ['Trace\\.beginSection\\('],
    constant_definition_patterns: ['const val (?<name>\\w+) ='], thread_creation_patterns: ['Thread\\('],
    template_placeholder: '\\d+', framework_slices: [{match: 'RV OnBindView', symbols: ['onBindViewHolder']}],
  });

  it('accepts the shipped policy and a minimal one', () => {
    expect(policy.maxInternalSearches).toBeGreaterThan(0);
    expect(() => parseSourceAnchorNormalization(base())).not.toThrow();
  });

  it.each([
    ['an unknown key', {...base(), extra: 1}],
    ['a constant pattern without a name group', {...base(), constant_definition_patterns: ['const val \\w+']}],
    ['an invalid regular expression', {...base(), trace_call_patterns: ['(']}],
    ['a framework slice with both match and prefix', {...base(), framework_slices: [{match: 'a', prefix: 'b', framework: true}]}],
    ['a framework slice that neither overrides nor is a framework slice', {...base(), framework_slices: [{match: 'a'}]}],
  ])('rejects %s', (_case, value) => {
    expect(() => parseSourceAnchorNormalization(value)).toThrow();
  });
});
