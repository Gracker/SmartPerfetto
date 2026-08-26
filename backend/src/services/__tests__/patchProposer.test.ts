// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {execFileSync} from 'child_process';

import {afterEach, beforeEach, describe, expect, it} from '@jest/globals';

import {CodeLookupLedger} from '../codebase/codeLookupLedger';
import {CodebaseRegistry} from '../codebase/codebaseRegistry';
import {PatchProposer} from '../codebase/patchProposer';
import {RagStore} from '../ragStore';

let tmpDir: string;
let appRoot: string;
let registry: CodebaseRegistry;
let store: RagStore;
let ledger: CodeLookupLedger;
let codebaseId: string;
const scope = {tenantId: 'tenant-patch', workspaceId: 'workspace-patch', userId: 'user-patch'};

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'patch-proposer-'));
  appRoot = path.join(tmpDir, 'app');
  fs.mkdirSync(path.join(appRoot, 'src'), {recursive: true});
  fs.writeFileSync(path.join(appRoot, 'src/Main.kt'), 'fun slow() {\n  Thread.sleep(50)\n}\n');
  execFileSync('git', ['init'], {cwd: appRoot, stdio: 'ignore'});
  registry = new CodebaseRegistry(path.join(tmpDir, 'codebases.json'));
  const ref = registry.register({
    kind: 'app_source',
    displayName: 'app',
    rootPath: appRoot,
    rootRealpath: appRoot,
    sendToProvider: true,
    ...scope,
  });
  codebaseId = ref.codebaseId;
  const sourceGeneration = 'codebase_2_patch';
  registry.activateIndexGeneration(codebaseId, scope, ref.indexGeneration, {
    lastIngestStatus: 'ok',
    activeGeneration: sourceGeneration,
    contentFingerprint: 'patch-content',
    chunkCount: 1,
  });
  store = new RagStore(path.join(tmpDir, 'rag.json'));
  store.addChunk({
    chunkId: 'chunk-main',
    kind: 'app_source',
    uri: `codebase://${codebaseId}/src/Main.kt`,
    snippet: 'fun slow() {\n  Thread.sleep(50)\n}',
    indexedAt: Date.now(),
    filePath: 'src/Main.kt',
    lineRange: {start: 1, end: 3},
    symbol: 'slow',
    codebaseId,
    registryOrigin: 'codebase_registry',
    sourceGeneration,
  }, scope);
  ledger = new CodeLookupLedger('session-patch', 1000, 3, path.join(tmpDir, 'ledger.jsonl'));
  ledger.record({
    turn: 1,
    ts: Date.now(),
    toolName: 'lookup_app_source',
    codebaseId,
    chunkIds: ['chunk-main'],
    consentApplied: true,
    tokensSpent: 10,
    outcome: 'success',
    legacyPath: false,
  });
});

afterEach(async () => {
  await ledger?.flush();
  fs.rmSync(tmpDir, {recursive: true, force: true});
});

function proposer() {
  return new PatchProposer(store, registry, ledger, scope);
}

describe('PatchProposer', () => {
  it('returns verified diff only when target file is in prior lookup and apply-check passes', () => {
    const diff = [
      'diff --git a/src/Main.kt b/src/Main.kt',
      '--- a/src/Main.kt',
      '+++ b/src/Main.kt',
      '@@ -1,3 +1,3 @@',
      ' fun slow() {',
      '-  Thread.sleep(50)',
      '+  // avoid blocking startup',
      ' }',
      '',
    ].join('\n');

    const result = proposer().propose({
      contextChunkIds: ['chunk-main'],
      problem: 'startup is blocked by sleep',
      proposedDiff: diff,
      turn: 2,
    });

    expect(result.patchStatus).toBe('verified');
    expect(result.diff).toBe(diff);
    expect(result.applyCheck).toMatchObject({ran: true, passed: true});
  });

  it('returns a non-copyable sketch when no diff is supplied', () => {
    const result = proposer().propose({
      contextChunkIds: ['chunk-main'],
      problem: 'startup is blocked by sleep',
      turn: 2,
    });

    expect(result.patchStatus).toBe('sketch');
    expect(result.diff).toBeUndefined();
    expect(result.patchSketch).toContain('src/Main.kt');
  });

  it('rejects missing prior lookup and cross-codebase patches', async () => {
    const emptyLedger = new CodeLookupLedger('empty', 1000, 3, path.join(tmpDir, 'empty.jsonl'));
    const noPrior = new PatchProposer(store, registry, emptyLedger, scope)
      .propose({contextChunkIds: ['chunk-main'], problem: 'x'});
    expect(noPrior).toMatchObject({patchStatus: 'unverified', unsupportedReason: 'prior_lookup_required'});
    await emptyLedger.flush();

    const otherRef = registry.register({
      kind: 'app_source',
      displayName: 'other',
      rootPath: appRoot,
      rootRealpath: appRoot,
      sendToProvider: true,
      ...scope,
    });
    const otherGeneration = 'codebase_2_other';
    registry.activateIndexGeneration(otherRef.codebaseId, scope, otherRef.indexGeneration, {
      lastIngestStatus: 'ok',
      activeGeneration: otherGeneration,
      contentFingerprint: 'other-content',
      chunkCount: 1,
    });
    store.addChunk({
      chunkId: 'chunk-other',
      kind: 'app_source',
      uri: `codebase://${otherRef.codebaseId}/src/Other.kt`,
      snippet: 'fun other() {}',
      indexedAt: Date.now(),
      filePath: 'src/Other.kt',
      lineRange: {start: 1, end: 1},
      symbol: 'other',
      codebaseId: otherRef.codebaseId,
      registryOrigin: 'codebase_registry',
      sourceGeneration: otherGeneration,
    }, scope);
    ledger.record({
      turn: 1,
      ts: Date.now(),
      toolName: 'lookup_app_source',
      codebaseId: otherRef.codebaseId,
      chunkIds: ['chunk-other'],
      consentApplied: true,
      tokensSpent: 10,
      outcome: 'success',
      legacyPath: false,
    });

    const cross = proposer().propose({
      contextChunkIds: ['chunk-main', 'chunk-other'],
      problem: 'x',
    });
    expect(cross).toMatchObject({
      patchStatus: 'unverified',
      unsupportedReason: 'multi_codebase_not_supported_phase1',
    });
  });

  it('rejects chunks from an inactive codebase generation', () => {
    store.addChunk({
      chunkId: 'chunk-stale',
      kind: 'app_source',
      uri: `codebase://${codebaseId}/src/Main.kt`,
      snippet: 'stale source',
      indexedAt: Date.now(),
      filePath: 'src/Main.kt',
      codebaseId,
      registryOrigin: 'codebase_registry',
      sourceGeneration: 'codebase_stale',
    }, scope);
    ledger.record({
      turn: 1,
      ts: Date.now(),
      toolName: 'lookup_app_source',
      codebaseId,
      chunkIds: ['chunk-stale'],
      consentApplied: true,
      tokensSpent: 1,
      outcome: 'success',
      legacyPath: false,
    });

    expect(proposer().propose({contextChunkIds: ['chunk-stale'], problem: 'x'})).toMatchObject({
      patchStatus: 'unverified',
      unsupportedReason: 'inactive_codebase_generation',
    });
  });

  it('does not return diff text when file scoping or apply-check fails', () => {
    const outside = proposer().propose({
      contextChunkIds: ['chunk-main'],
      problem: 'x',
      proposedDiff: 'diff --git a/src/Other.kt b/src/Other.kt\n--- a/src/Other.kt\n+++ b/src/Other.kt\n@@ -1 +1 @@\n-a\n+b\n',
    });
    expect(outside.patchStatus).toBe('unverified');
    expect(outside.diff).toBeUndefined();

    const badHunk = proposer().propose({
      contextChunkIds: ['chunk-main'],
      problem: 'x',
      proposedDiff: 'diff --git a/src/Main.kt b/src/Main.kt\n--- a/src/Main.kt\n+++ b/src/Main.kt\n@@ -20,1 +20,1 @@\n-missing\n+replacement\n',
    });
    expect(badHunk.patchStatus).toBe('sketch');
    expect(badHunk.diff).toBeUndefined();
    expect(badHunk.applyCheck).toMatchObject({ran: true, passed: false});
  });
});
