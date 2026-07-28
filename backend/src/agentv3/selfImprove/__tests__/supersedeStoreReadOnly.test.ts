// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

/**
 * Tests for `openSupersedeStoreReadOnly` (Plan 41 M1a). Lives in its
 * own file because the adjacent `supersedeStore.test.ts` uses the
 * `type` mid-import syntax that the project's current babel config
 * cannot parse (it is not picked up by the regular jest gate either).
 * Keeping this isolated guarantees the read-only adapter has a
 * runnable test gate.
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import {describe, it, expect, beforeEach, afterEach} from '@jest/globals';

import {
  openSupersedeStore,
  openSupersedeStoreReadOnly,
  SupersedeStoreHandle,
} from '../supersedeStore';

let tmpDir: string;
let dbPath: string;

function sqliteFamily(): Map<string, Buffer> {
  return new Map(
    fs.readdirSync(tmpDir)
      .filter((name) => name.startsWith(path.basename(dbPath)))
      .sort()
      .map((name) => [name, fs.readFileSync(path.join(tmpDir, name))]),
  );
}

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'supersede-ro-test-'));
  dbPath = path.join(tmpDir, 'supersede.db');
});

afterEach(() => {
  if (fs.existsSync(tmpDir)) {
    fs.rmSync(tmpDir, {recursive: true, force: true});
  }
});

describe('openSupersedeStoreReadOnly — Plan 41 M1a adapter', () => {
  it('returns null for :memory: dbPath (no shared state)', () => {
    expect(openSupersedeStoreReadOnly({dbPath: ':memory:'})).toBeNull();
  });

  it('returns null when the db file does not exist (no mkdir, no creation)', () => {
    expect(fs.existsSync(dbPath)).toBe(false);
    expect(openSupersedeStoreReadOnly({dbPath})).toBeNull();
    // The adapter must not mkdir or create the db file.
    expect(fs.existsSync(dbPath)).toBe(false);
  });

  it('opens an existing db and reads markers without mutating it', () => {
    // Seed via the writable openSupersedeStore.
    const writable = openSupersedeStore({dbPath});
    writable.createPendingReview({
      failureModeHash: 'h_observed',
      strategyFile: 'scrolling.strategy.md',
      strategyContentHash: 'cont_v1',
      patchFingerprint: 'patch_v1',
    });
    writable.close();

    const readonly = openSupersedeStoreReadOnly({dbPath});
    expect(readonly).not.toBeNull();
    const marker = readonly!.findActiveByHash('h_observed');
    expect(marker?.state).toBe('pending_review');
    readonly!.close();
  });

  it('the SQLite family does not change across 1000 read-only operations', () => {
    const writable = openSupersedeStore({dbPath});
    writable.createPendingReview({
      failureModeHash: 'h_observed',
      strategyFile: 'scrolling.strategy.md',
      strategyContentHash: 'cont_v1',
      patchFingerprint: 'patch_v1',
    });
    writable.close();

    const before = sqliteFamily();
    const readonly = openSupersedeStoreReadOnly({dbPath});
    expect(readonly).not.toBeNull();
    for (let i = 0; i < 1000; i++) {
      readonly!.findActiveByHash('h_observed');
      readonly!.findActiveByHash('h_missing');
    }
    readonly!.close();
    expect(sqliteFamily()).toEqual(before);
  });

  it('reads committed active-WAL rows without touching source sidecars', () => {
    const writable = openSupersedeStore({dbPath});
    writable.createPendingReview({
      failureModeHash: 'h_wal',
      strategyFile: 'scrolling.strategy.md',
      strategyContentHash: 'cont_v1',
      patchFingerprint: 'patch_v1',
    });
    const before = sqliteFamily();
    expect([...before.keys()]).toContain(`${path.basename(dbPath)}-wal`);

    const readonly = openSupersedeStoreReadOnly({dbPath});
    expect(readonly?.findActiveByHash('h_wal')?.state).toBe('pending_review');
    readonly?.close();

    expect(sqliteFamily()).toEqual(before);
    writable.close();
  });

  it('retains query-only runtime defense behind the closed read interface', () => {
    const writable = openSupersedeStore({dbPath});
    writable.close();

    const readonly = openSupersedeStoreReadOnly({dbPath});
    expect(readonly).not.toBeNull();
    expect(() =>
      (readonly as unknown as SupersedeStoreHandle).createPendingReview({
        failureModeHash: 'h_other',
        strategyFile: 'scrolling.strategy.md',
        strategyContentHash: 'c',
        patchFingerprint: 'p',
      }),
    ).toThrow();
    readonly!.close();
  });
});
