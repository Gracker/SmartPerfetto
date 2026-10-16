// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

/**
 * locate_trace_anchor against the real HighPerformanceFriendsCircle checkout
 * the code-aware gate already depends on: one anchor per normalization class,
 * each expected to land on the exact line that emits it.
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import {CodebaseRegistry} from '../services/codebase/codebaseRegistry';
import {OnDemandSourceAccessService} from '../services/codebase/onDemandSourceAccess';
import {
  loadSourceAnchorNormalization,
  locateTraceAnchor,
  TRACE_ANCHOR_SEARCH_OPTIONS,
  type TraceAnchorKind,
} from '../services/codebase/traceAnchorLocator';

interface AnchorCase {
  label: string;
  anchor: string;
  kind: TraceAnchorKind;
  processName?: string;
  /** Relative path suffix and line of the expected first candidate. */
  expectFile: string;
  expectLine: number;
  expectMatchedBy: string;
  expectAmbiguous?: boolean;
}

const CASES: AnchorCase[] = [
  {label: 'literal', anchor: 'HPFC_TAP_ON_DRAW', kind: 'slice',
    expectFile: 'interaction/InteractionBenchmarkActivity.java', expectLine: 77, expectMatchedBy: 'trace_call'},
  {label: 'fully qualified android.os.Trace', anchor: 'RealInflation', kind: 'slice',
    expectFile: 'launch/aosp/MainActivity.kt', expectLine: 52, expectMatchedBy: 'trace_call'},
  {label: 'templated number (Kotlin template)', anchor: 'BgService_Task3_17', kind: 'slice',
    expectFile: 'switch_common/BackgroundLoadService.kt', expectLine: 196, expectMatchedBy: 'trace_call'},
  {label: 'templated number (concatenation)', anchor: 'CustomScroll_longFrameLoad_3', kind: 'slice',
    expectFile: 'ui/timeline/LoadStressSimulator.java', expectLine: 153, expectMatchedBy: 'trace_call'},
  {label: 'truncated thread name', anchor: 'PureRenderThrea', kind: 'thread',
    expectFile: 'wechatfriendforpurerenderthread/PureRenderListView.java', expectLine: 231,
    expectMatchedBy: 'thread_creation'},
  {label: 'same name in two modules', anchor: 'MediumLoadBetweenFramesGeckoViewActivity_onCreate', kind: 'slice',
    expectFile: 'MediumLoadBetweenFramesGeckoViewActivity.java', expectLine: 20, expectMatchedBy: 'trace_call',
    expectAmbiguous: true},
  {label: 'same name, disambiguated by process', anchor: 'MediumLoadBetweenFramesGeckoViewActivity_onCreate',
    kind: 'slice', processName: 'com.example.wechatfriendforwebviewsurface',
    expectFile: 'wechatfriendforwebviewsurface/MediumLoadBetweenFramesGeckoViewActivity.java', expectLine: 20,
    expectMatchedBy: 'trace_call', expectAmbiguous: false},
];

function resolveRoot(): string {
  const candidates = [
    process.env.SMARTPERFETTO_HPFC_ROOT,
    path.join(os.homedir(), 'Code', 'HighPerformanceFriendsCircle'),
    path.join(os.homedir(), 'SynologyDrive', 'HighPerformanceFriendsCircle'),
  ].filter((candidate): candidate is string => Boolean(candidate));
  const root = candidates.find(candidate => fs.existsSync(candidate));
  if (!root) throw new Error('HighPerformanceFriendsCircle checkout not found (set SMARTPERFETTO_HPFC_ROOT)');
  return root;
}

async function main(): Promise<void> {
  const root = resolveRoot();
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'trace-anchor-hpfc-'));
  try {
    const registry = new CodebaseRegistry(path.join(tmpDir, 'registry.json'));
    const {codebaseId} = registry.register({kind: 'app_source', displayName: 'HPFC', rootPath: root,
      rootAuthorization: 'native_picker', sendToProvider: true});
    const access = new OnDemandSourceAccessService({registry});
    const policy = loadSourceAnchorNormalization();
    const failures: string[] = [];
    for (const testCase of CASES) {
      const result = await locateTraceAnchor({anchor: testCase.anchor, kind: testCase.kind, codebaseId,
        processName: testCase.processName, maxResults: 5, policy,
        search: query => access.search({codebaseId, scope: {}, query, mode: 'metadata_only',
          ...TRACE_ANCHOR_SEARCH_OPTIONS})});
      const top = result.matches[0];
      const problems = [
        !top ? 'no candidate' : undefined,
        top && !top.filePath.endsWith(testCase.expectFile) ? `file ${top.filePath}` : undefined,
        top && !top.matchLines.includes(testCase.expectLine) ? `lines ${top.matchLines.join(',')}` : undefined,
        top && top.matchedBy !== testCase.expectMatchedBy ? `matchedBy ${top.matchedBy}` : undefined,
        testCase.expectAmbiguous !== undefined && Boolean(result.ambiguous) !== testCase.expectAmbiguous
          ? `ambiguous ${Boolean(result.ambiguous)}` : undefined,
        result.searchesRun > policy.maxInternalSearches ? `searches ${result.searchesRun}` : undefined,
      ].filter((problem): problem is string => Boolean(problem));
      console.log(`${problems.length === 0 ? 'PASS' : 'FAIL'} ${testCase.label}: ${testCase.anchor}` +
        `${problems.length ? ` (${problems.join('; ')})` : ''} [searches=${result.searchesRun}]`);
      if (problems.length) failures.push(testCase.label);
    }
    if (failures.length) throw new Error(`trace anchor locate failed: ${failures.join(', ')}`);
  } finally {
    fs.rmSync(tmpDir, {recursive: true, force: true});
  }
}

main().catch(error => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
