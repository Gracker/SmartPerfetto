// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import {afterEach, beforeEach, describe, expect, it, jest} from '@jest/globals';

import {CodeLookupLedger, type CodeLookupLedgerEntry} from '../codeLookupLedger';
import {projectPrivateSessionStateSnapshot} from '../../security/privateAnalysisProjection';

const PRIVATE_MARKER = 'PrivateRendererSecret';

let tmpDir: string;
let ledgerPath: string;
let warn: ReturnType<typeof jest.spyOn>;

beforeEach(() => {
  warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'code-lookup-ledger-recovery-'));
  ledgerPath = path.join(tmpDir, 'session.codeLookupLedger.jsonl');
});

afterEach(() => {
  jest.restoreAllMocks();
  fs.rmSync(tmpDir, {recursive: true, force: true});
});

function lookup(overrides: Partial<CodeLookupLedgerEntry> = {}): CodeLookupLedgerEntry {
  return {
    turn: 1,
    ts: 1714600000000,
    toolName: 'lookup_app_source',
    codebaseId: 'cb_1',
    chunkIds: [`chunk-${PRIVATE_MARKER}`],
    consentApplied: true,
    tokensSpent: 10,
    outcome: 'success',
    legacyPath: false,
    ...overrides,
  };
}

function patch(overrides: Partial<CodeLookupLedgerEntry> = {}): CodeLookupLedgerEntry {
  return lookup({toolName: 'propose_patch', tokensSpent: 0, outcome: 'patch_sketch', ...overrides});
}

async function writeLedger(
  entries: CodeLookupLedgerEntry[],
  authorizationFingerprint?: string,
): Promise<void> {
  const ledger = new CodeLookupLedger('session', 1000, 2, ledgerPath, authorizationFingerprint);
  for (const entry of entries) ledger.record(entry);
  await ledger.flush();
}

/** A crash in the middle of appending `entry`: part of its line, no newline. */
function appendTornRecord(entry: CodeLookupLedgerEntry, keep = 0.6): Buffer {
  const line = Buffer.from(JSON.stringify(entry), 'utf-8');
  const fragment = line.subarray(0, Math.floor(line.length * keep));
  fs.appendFileSync(ledgerPath, fragment);
  return fragment;
}

function evidenceFiles(): string[] {
  return fs.readdirSync(tmpDir).filter(name => name.includes('.unreadable-'));
}

function evidenceBytes(name: string): Buffer {
  const text = fs.readFileSync(path.join(tmpDir, name), 'utf-8');
  expect(text.endsWith('\n')).toBe(true);
  return Buffer.from(JSON.parse(text).unreadableRecordBase64, 'base64');
}

function restore(authorizationFingerprint?: string): CodeLookupLedger {
  return CodeLookupLedger.restore('session', 1000, 2, ledgerPath, authorizationFingerprint);
}

describe('CodeLookupLedger torn-tail recovery', () => {
  it('charges a torn final record conservatively instead of failing or skipping it', async () => {
    await writeLedger([lookup()]);
    appendTornRecord(patch());

    const restored = restore();
    expect(restored.getEntries()).toHaveLength(1);
    expect(restored.hasPriorLookupOf(`chunk-${PRIVATE_MARKER}`)).toBe(true);
    // The torn record may have spent everything that remained, and may have been a patch.
    expect(restored.remainingTokens()).toBe(0);
    expect(restored.remainingPatches()).toBe(1);
    expect(restored.toSnapshotSummary()).toEqual({
      lookupCount: 1,
      patchCount: 0,
      referencedCodebaseIds: ['cb_1'],
      usedCodebaseIds: ['cb_1'],
      unreadableRecordCount: 1,
    });
  });

  it('never grants patch authorization from a torn lookup', async () => {
    appendTornRecord(lookup({chunkIds: ['chunk-torn']}), 0.9);

    const restored = restore();
    expect(restored.hasPriorLookupOf('chunk-torn')).toBe(false);
    expect(restored.hasSuccessfulCodeLookup()).toBe(false);
  });

  it('restore stays read-only: the file is untouched until the writer appends', async () => {
    await writeLedger([lookup()]);
    const fragment = appendTornRecord(lookup());
    const before = fs.readFileSync(ledgerPath);

    restore().toSnapshotSummary();
    restore().getEntries();

    expect(fs.readFileSync(ledgerPath).equals(before)).toBe(true);
    expect(before.subarray(before.length - fragment.length).equals(fragment)).toBe(true);
    expect(evidenceFiles()).toEqual([]);
  });

  it('round trips restore → record → flush → restore with the degradation kept durable', async () => {
    await writeLedger([lookup()]);
    const fragment = appendTornRecord(patch());

    const writer = restore();
    writer.record(lookup({turn: 2, chunkIds: ['chunk-after'], tokensSpent: 0}));
    await writer.flush();

    // Every line is now a complete record, and the torn bytes were preserved.
    const lines = fs.readFileSync(ledgerPath, 'utf-8').split('\n');
    expect(lines.pop()).toBe('');
    expect(lines).toHaveLength(3);
    for (const line of lines) expect(() => JSON.parse(line)).not.toThrow();
    expect(JSON.parse(lines[1])).toEqual({
      unreadableRecord: {bytes: fragment.length, repairedAt: expect.any(Number)},
    });
    const files = evidenceFiles();
    expect(files).toHaveLength(1);
    const [evidence] = files;
    // Log cleanup removes `*.jsonl` files by age, so the evidence goes with the ledger.
    expect(evidence).toMatch(/^session\.codeLookupLedger\.unreadable-\d+-\d+\.jsonl$/);
    expect(evidenceBytes(evidence).equals(fragment)).toBe(true);
    expect(fs.statSync(path.join(tmpDir, evidence)).mode & 0o777).toBe(0o600);

    const reread = restore();
    expect(reread.getEntries().map(entry => entry.turn)).toEqual([1, 2]);
    expect(reread.hasPriorLookupOf('chunk-after')).toBe(true);
    expect(reread.remainingTokens()).toBe(0);
    expect(reread.remainingPatches()).toBe(1);
    expect(reread.toSnapshotSummary().unreadableRecordCount).toBe(1);

    // A second writer session appends normally: no repair is pending any more.
    const next = restore();
    next.record(lookup({turn: 3}));
    await next.flush();
    expect(restore().getEntries()).toHaveLength(3);
    expect(evidenceFiles()).toHaveLength(1);

    expect(warn).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(warn.mock.calls)).not.toContain(PRIVATE_MARKER);
  });

  it('a crash between writing the marker and truncating still restores conservatively', async () => {
    await writeLedger([lookup()]);
    // Marker written over a longer fragment, truncate never ran: the remainder is unterminated.
    fs.appendFileSync(ledgerPath, `${JSON.stringify({unreadableRecord: {bytes: 400, repairedAt: 1}})}\n`);
    fs.appendFileSync(ledgerPath, `"chunk-${PRIVATE_MARKER}"],"consentApplied":true`);

    const restored = restore();
    expect(restored.toSnapshotSummary().unreadableRecordCount).toBe(2);
    expect(restored.remainingTokens()).toBe(0);
    expect(restored.remainingPatches()).toBe(0);
    restored.record(lookup({turn: 2}));
    await restored.flush();
    expect(restore().toSnapshotSummary().unreadableRecordCount).toBe(2);
  });

  it('charges an unreadable record to every authorization partition but keeps capability partitioned', async () => {
    await writeLedger([lookup({chunkIds: ['chunk-old'], tokensSpent: 5})], 'context-old');
    appendTornRecord(lookup());

    const writer = restore('context-new');
    expect(writer.hasPriorLookupOf('chunk-old')).toBe(false);
    expect(writer.remainingTokens()).toBe(0);
    expect(writer.remainingPatches()).toBe(1);
    writer.record(lookup({chunkIds: ['chunk-new'], tokensSpent: 0}));
    await writer.flush();

    const oldPartition = restore('context-old');
    expect(oldPartition.hasPriorLookupOf('chunk-old')).toBe(true);
    expect(oldPartition.hasPriorLookupOf('chunk-new')).toBe(false);
    expect(oldPartition.remainingTokens()).toBe(0);

    const newPartition = restore('context-new');
    expect(newPartition.hasPriorLookupOf('chunk-new')).toBe(true);
    expect(newPartition.hasPriorLookupOf('chunk-old')).toBe(false);
    expect(newPartition.toSnapshotSummary()).toMatchObject({lookupCount: 2, unreadableRecordCount: 1});
  });

  it('a complete record that only lacks its newline is kept and terminated, without degradation', async () => {
    await writeLedger([lookup()]);
    fs.appendFileSync(ledgerPath, JSON.stringify(lookup({turn: 2, tokensSpent: 7})));

    const writer = restore();
    expect(writer.getEntries()).toHaveLength(2);
    expect(writer.remainingTokens()).toBe(983);
    expect(writer.toSnapshotSummary().unreadableRecordCount).toBeUndefined();
    writer.record(lookup({turn: 3, tokensSpent: 0}));
    await writer.flush();

    const reread = restore();
    expect(reread.getEntries().map(entry => entry.turn)).toEqual([1, 2, 3]);
    expect(reread.remainingTokens()).toBe(983);
    expect(evidenceFiles()).toEqual([]);
  });

  it('treats a fragment cut inside a multi-byte character as torn and preserves it byte-exactly', async () => {
    await writeLedger([lookup()]);
    const line = Buffer.from(JSON.stringify(lookup({chunkIds: ['chunk-界面']})), 'utf-8');
    const cut = line.indexOf(Buffer.from('界', 'utf-8')) + 1;
    const fragment = line.subarray(0, cut);
    fs.appendFileSync(ledgerPath, fragment);

    const writer = restore();
    expect(writer.toSnapshotSummary().unreadableRecordCount).toBe(1);
    writer.record(lookup({turn: 2}));
    await writer.flush();
    expect(evidenceBytes(evidenceFiles()[0]).equals(fragment)).toBe(true);
  });

  it('keeps failing closed for a corrupt middle line, naming only its line number', async () => {
    await writeLedger([lookup()]);
    fs.appendFileSync(ledgerPath, `{"toolName":"lookup_app_source","chunkIds":["${PRIVATE_MARKER}"\n`);
    await writeLedger([lookup({turn: 3})]);

    let thrown: unknown;
    try {
      restore();
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(Error);
    expect((thrown as Error).message).toBe('code_lookup_ledger_corrupt_record: line 2');
    expect(String((thrown as Error).stack)).not.toContain(PRIVATE_MARKER);
  });

  it('rejects a body line that is valid JSON but not a record', async () => {
    await writeLedger([lookup()]);
    fs.appendFileSync(ledgerPath, 'null\n');
    expect(() => restore()).toThrow('code_lookup_ledger_corrupt_record: line 2');
  });

  it('refuses to repair a tail that changed after restore', async () => {
    await writeLedger([lookup()]);
    appendTornRecord(lookup());

    const writer = restore();
    fs.appendFileSync(ledgerPath, 'more');
    const before = fs.readFileSync(ledgerPath);
    writer.record(lookup({turn: 2}));
    await expect(writer.flush()).rejects.toThrow(/^code_lookup_ledger_changed_since_restore$/);
    expect(fs.readFileSync(ledgerPath).equals(before)).toBe(true);
    expect(evidenceFiles()).toEqual([]);

    // The failure is sticky: nothing later lands after the unrepaired tail.
    writer.record(lookup({turn: 3}));
    await expect(writer.flush()).rejects.toThrow(/^code_lookup_ledger_changed_since_restore$/);
    expect(fs.readFileSync(ledgerPath).equals(before)).toBe(true);
  });

  it('a ledger that did not restore the file refuses to append after an unterminated line', async () => {
    await writeLedger([lookup()]);
    appendTornRecord(lookup());
    const before = fs.readFileSync(ledgerPath);

    const fresh = new CodeLookupLedger('session', 1000, 2, ledgerPath);
    fresh.record(lookup({turn: 2}));
    await expect(fresh.flush()).rejects.toThrow(/^code_lookup_ledger_unterminated_record$/);
    expect(fs.readFileSync(ledgerPath).equals(before)).toBe(true);
  });

  it('carries the unreadable count through the private snapshot projection', async () => {
    await writeLedger([lookup()]);
    appendTornRecord(lookup());
    const summary = restore().toSnapshotSummary();

    const projected = projectPrivateSessionStateSnapshot({
      sessionId: 'session',
      dataEnvelopes: [],
      codeLookupSummary: summary,
    } as unknown as Parameters<typeof projectPrivateSessionStateSnapshot>[0]);
    expect(projected.codeLookupSummary?.unreadableRecordCount).toBe(1);
  });
});
