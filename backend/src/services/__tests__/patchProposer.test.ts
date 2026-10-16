// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {execFileSync} from 'child_process';
import {createHash} from 'crypto';

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
  ledger = new CodeLookupLedger('session-patch', 3, path.join(tmpDir, 'ledger.jsonl'));
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

function hashFile(filePath: string): string {
  return createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
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
    const emptyLedger = new CodeLookupLedger('empty', 3, path.join(tmpDir, 'empty.jsonl'));
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

  it('checks codebase-relative patches against a registered root nested inside a parent repository', () => {
    const parentRoot = path.join(tmpDir, 'parent');
    const nestedRoot = path.join(parentRoot, 'registered');
    const sourcePath = path.join(nestedRoot, 'Main.kt');
    fs.mkdirSync(nestedRoot, {recursive: true});
    fs.writeFileSync(sourcePath, 'fun nested() {\n  println("before")\n}\n');
    execFileSync('git', ['init'], {cwd: parentRoot, stdio: 'ignore'});
    execFileSync('git', ['add', 'registered/Main.kt'], {cwd: parentRoot, stdio: 'ignore'});

    const nestedRef = registry.register({
      kind: 'app_source',
      displayName: 'nested',
      rootPath: nestedRoot,
      rootRealpath: nestedRoot,
      sendToProvider: true,
      ...scope,
    });
    const nestedGeneration = 'codebase_nested_patch';
    registry.activateIndexGeneration(nestedRef.codebaseId, scope, nestedRef.indexGeneration, {
      lastIngestStatus: 'ok',
      activeGeneration: nestedGeneration,
      contentFingerprint: 'nested-content',
      chunkCount: 1,
    });
    store.addChunk({
      chunkId: 'chunk-nested',
      kind: 'app_source',
      uri: `codebase://${nestedRef.codebaseId}/Main.kt`,
      snippet: 'fun nested() {\n  println("before")\n}',
      indexedAt: Date.now(),
      filePath: 'Main.kt',
      codebaseId: nestedRef.codebaseId,
      registryOrigin: 'codebase_registry',
      sourceGeneration: nestedGeneration,
    }, scope);
    ledger.record({
      turn: 1,
      ts: Date.now(),
      toolName: 'lookup_app_source',
      codebaseId: nestedRef.codebaseId,
      chunkIds: ['chunk-nested'],
      consentApplied: true,
      tokensSpent: 1,
      outcome: 'success',
      legacyPath: false,
    });
    const nestedProposer = new PatchProposer(store, registry, ledger, scope);
    const beforeFile = hashFile(sourcePath);
    const beforeIndex = hashFile(path.join(parentRoot, '.git/index'));

    const valid = nestedProposer.propose({
      contextChunkIds: ['chunk-nested'],
      problem: 'update nested source',
      proposedDiff: [
        'diff --git a/Main.kt b/Main.kt',
        '--- a/Main.kt',
        '+++ b/Main.kt',
        '@@ -1,3 +1,3 @@',
        ' fun nested() {',
        '-  println("before")',
        '+  println("after")',
        ' }',
        '',
      ].join('\n'),
      turn: 2,
    });
    const invalid = nestedProposer.propose({
      contextChunkIds: ['chunk-nested'],
      problem: 'reject a stale nested hunk',
      proposedDiff: [
        'diff --git a/Main.kt b/Main.kt',
        '--- a/Main.kt',
        '+++ b/Main.kt',
        '@@ -1,3 +1,3 @@',
        ' fun nested() {',
        '-  THIS_LINE_DOES_NOT_EXIST',
        '+  println("after")',
        ' }',
        '',
      ].join('\n'),
      turn: 2,
    });

    expect(valid).toMatchObject({patchStatus: 'verified', applyCheck: {ran: true, passed: true}});
    expect(invalid).toMatchObject({patchStatus: 'sketch', applyCheck: {ran: true, passed: false}});
    expect(invalid.diff).toBeUndefined();
    expect(hashFile(sourcePath)).toBe(beforeFile);
    expect(hashFile(path.join(parentRoot, '.git/index'))).toBe(beforeIndex);
  });

  it('preserves apply-check behavior for a registered root outside a Git repository', () => {
    const nonGitRoot = path.join(tmpDir, 'plain-directory');
    const sourcePath = path.join(nonGitRoot, 'Main.kt');
    fs.mkdirSync(nonGitRoot, {recursive: true});
    fs.writeFileSync(sourcePath, 'fun plain() {\n  println("before")\n}\n');

    const ref = registry.register({
      kind: 'app_source',
      displayName: 'plain',
      rootPath: nonGitRoot,
      rootRealpath: nonGitRoot,
      sendToProvider: true,
      ...scope,
    });
    const sourceGeneration = 'codebase_plain_patch';
    registry.activateIndexGeneration(ref.codebaseId, scope, ref.indexGeneration, {
      lastIngestStatus: 'ok',
      activeGeneration: sourceGeneration,
      contentFingerprint: 'plain-content',
      chunkCount: 1,
    });
    store.addChunk({
      chunkId: 'chunk-plain',
      kind: 'app_source',
      uri: `codebase://${ref.codebaseId}/Main.kt`,
      snippet: 'fun plain() {\n  println("before")\n}',
      indexedAt: Date.now(),
      filePath: 'Main.kt',
      codebaseId: ref.codebaseId,
      registryOrigin: 'codebase_registry',
      sourceGeneration,
    }, scope);
    ledger.record({
      turn: 1,
      ts: Date.now(),
      toolName: 'lookup_app_source',
      codebaseId: ref.codebaseId,
      chunkIds: ['chunk-plain'],
      consentApplied: true,
      tokensSpent: 1,
      outcome: 'success',
      legacyPath: false,
    });
    const plainProposer = new PatchProposer(store, registry, ledger, scope);
    const before = hashFile(sourcePath);
    const baseHeader = ['diff --git a/Main.kt b/Main.kt', '--- a/Main.kt', '+++ b/Main.kt'];
    const valid = plainProposer.propose({
      contextChunkIds: ['chunk-plain'],
      problem: 'update plain source',
      proposedDiff: [...baseHeader, '@@ -1,3 +1,3 @@', ' fun plain() {', '-  println("before")', '+  println("after")', ' }', ''].join('\n'),
    });
    const invalid = plainProposer.propose({
      contextChunkIds: ['chunk-plain'],
      problem: 'reject stale plain source',
      proposedDiff: [...baseHeader, '@@ -1,3 +1,3 @@', ' fun plain() {', '-  missing()', '+  println("after")', ' }', ''].join('\n'),
    });

    expect(valid).toMatchObject({patchStatus: 'verified', applyCheck: {ran: true, passed: true}});
    expect(invalid).toMatchObject({patchStatus: 'sketch', applyCheck: {ran: true, passed: false}});
    expect(hashFile(sourcePath)).toBe(before);
  });

  it.each([
    {
      name: 'rename',
      diff: [
        'diff --git a/src/Unlooked.kt b/src/Main.kt',
        'similarity index 100%',
        'rename from src/Unlooked.kt',
        'rename to src/Main.kt',
        '',
      ].join('\n'),
    },
    {
      name: 'copy',
      diff: [
        'diff --git a/src/Unlooked.kt b/src/Main.kt',
        'similarity index 100%',
        'copy from src/Unlooked.kt',
        'copy to src/Main.kt',
        '',
      ].join('\n'),
    },
    {
      name: 'delete',
      diff: [
        'diff --git a/src/Unlooked.kt b/src/Main.kt',
        'deleted file mode 100644',
        '--- a/src/Unlooked.kt',
        '+++ /dev/null',
        '@@ -1 +0,0 @@',
        '-unlooked',
        '',
      ].join('\n'),
    },
  ])('rejects an unlooked old path in a $name before apply-check', ({diff}) => {
    const result = proposer().propose({
      contextChunkIds: ['chunk-main'],
      problem: 'do not authorize an unlooked old path',
      proposedDiff: diff,
    });

    expect(result).toMatchObject({
      patchStatus: 'unverified',
      unsupportedReason: 'diff_target_outside_context',
      applyCheck: {ran: false, passed: false},
    });
    expect(result.diff).toBeUndefined();
  });

  it.each([
    ['quoted diff paths', 'diff --git "a/src/Main.kt" "b/src/Main.kt"\n--- "a/src/Main.kt"\n+++ "b/src/Main.kt"\n'],
    ['whitespace in a path', 'diff --git a/src/Main.kt b/src/Main File.kt\n--- a/src/Main.kt\n+++ b/src/Main File.kt\n'],
    ['escaped path', 'diff --git a/src/Main\\t.kt b/src/Main.kt\n--- a/src/Main\\t.kt\n+++ b/src/Main.kt\n'],
    ['absolute old path', 'diff --git a/src/Main.kt b/src/Main.kt\n--- /src/Main.kt\n+++ b/src/Main.kt\n'],
    ['traversal path', 'diff --git a/src/Main.kt b/src/Main.kt\n--- a/src/Main.kt\n+++ b/../src/Main.kt\n'],
    ['empty header path', 'diff --git a/src/Main.kt b/src/Main.kt\n--- a/src/Main.kt\n+++ \n'],
    [
      'ambiguous header-like hunk content',
      'diff --git a/src/Main.kt b/src/Main.kt\n--- a/src/Main.kt\n+++ b/src/Main.kt\n@@ -1 +1 @@\n--- a/not-a-header.kt\n+++ b/not-a-header.kt\n',
    ],
  ])('fails closed for %s', (_name, diff) => {
    const result = proposer().propose({
      contextChunkIds: ['chunk-main'],
      problem: 'reject ambiguous patch paths',
      proposedDiff: diff,
    });

    expect(result).toMatchObject({
      patchStatus: 'unverified',
      unsupportedReason: 'diff_unparseable',
      applyCheck: {ran: false, passed: false},
    });
    expect(result.diff).toBeUndefined();
  });
});
