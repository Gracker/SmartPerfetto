// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import {afterEach, beforeEach, describe, expect, it, jest} from '@jest/globals';

import {
  openReviewOutbox,
  openReviewOutboxReadOnly,
  ReviewOutboxHandle,
} from '../reviewOutbox';
import {__testing as sqliteSnapshotTesting} from '../../../utils/sqliteReadSnapshot';

describe('openReviewOutboxReadOnly', () => {
  let root: string;
  let dbPath: string;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'sp-review-outbox-ro-'));
    dbPath = path.join(root, 'nested', 'review.db');
  });

  afterEach(() => {
    fs.rmSync(root, {recursive: true, force: true});
  });

  function sqliteFamily(): Map<string, Buffer> {
    if (!fs.existsSync(path.dirname(dbPath))) return new Map();
    return new Map(
      fs.readdirSync(path.dirname(dbPath))
        .filter((name) => name.startsWith(path.basename(dbPath)))
        .sort()
        .map((name) => [
          name,
          fs.readFileSync(path.join(path.dirname(dbPath), name)),
        ]),
    );
  }

  function snapshotDirectories(): string[] {
    return fs.readdirSync(os.tmpdir())
      .filter((name) => name.startsWith(sqliteSnapshotTesting.SNAPSHOT_PREFIX))
      .sort();
  }

  it('returns null without creating a directory or database', () => {
    expect(openReviewOutboxReadOnly({dbPath})).toBeNull();
    expect(fs.existsSync(path.dirname(dbPath))).toBe(false);
  });

  it('reads an existing outbox without changing its SQLite family', () => {
    const writable = openReviewOutbox({dbPath});
    writable.enqueue({dedupeKey: 'job-1', payload: {kind: 'test'}});
    writable.close();
    const before = sqliteFamily();
    const snapshotsBefore = snapshotDirectories();

    const readonly = openReviewOutboxReadOnly({dbPath});
    expect(readonly?.countByState()).toEqual({
      pending: 1,
      leased: 0,
      done: 0,
      failed: 0,
    });
    expect(readonly?.dailyJobCount()).toBe(1);
    readonly?.close();

    expect(sqliteFamily()).toEqual(before);
    expect(snapshotDirectories()).toEqual(snapshotsBefore);
  });

  it('reads committed active-WAL rows without touching source sidecars', () => {
    const writable = openReviewOutbox({dbPath});
    writable.enqueue({dedupeKey: 'wal-job', payload: {kind: 'wal-only'}});
    const before = sqliteFamily();
    expect([...before.keys()]).toContain(`${path.basename(dbPath)}-wal`);

    const readonly = openReviewOutboxReadOnly({dbPath});
    expect(readonly?.countByState().pending).toBe(1);
    readonly?.close();

    expect(sqliteFamily()).toEqual(before);
    writable.close();
  });

  it('retains query-only runtime defense behind the closed read interface', () => {
    const writable = openReviewOutbox({dbPath});
    writable.close();
    const readonly = openReviewOutboxReadOnly({dbPath});
    const consoleError = jest.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      const result = (readonly as unknown as ReviewOutboxHandle)
        .enqueue({dedupeKey: 'no-write', payload: {}});
      expect(result).toMatchObject({enqueued: false, reason: 'error'});
      expect(readonly?.countByState()).toEqual({
        pending: 0,
        leased: 0,
        done: 0,
        failed: 0,
      });
    } finally {
      consoleError.mockRestore();
      readonly?.close();
    }
  });
});
