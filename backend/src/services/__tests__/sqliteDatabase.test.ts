// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import {describe, expect, it} from '@jest/globals';
import {execFileSync} from 'child_process';
import * as fs from 'fs';
import * as path from 'path';

import Database, {bundledSqliteBinding} from '../sqliteDatabase';

const BACKEND = path.resolve(__dirname, '../../..');
const RUNTIME = {modules: '137', platform: 'linux', arch: 'x64'};

describe('sqliteDatabase', () => {
  it('leaves an addon built by the install in charge', () => {
    expect(bundledSqliteBinding(true, RUNTIME, () => true)).toBeUndefined();
  });

  it('uses the bundled addon of this runtime when the install built none', () => {
    expect(bundledSqliteBinding(false, RUNTIME, () => true))
      .toBe(path.join(BACKEND, 'prebuilts/better-sqlite3/node-v137-linux-x64/better_sqlite3.node'));
  });

  it('falls through for a runtime without a bundled addon', () => {
    expect(bundledSqliteBinding(false, {...RUNTIME, platform: 'freebsd'}, () => false)).toBeUndefined();
  });

  it('opens a working database and keeps the constructor identity', () => {
    const database = new Database(':memory:');
    try {
      expect(database.prepare('SELECT 1 AS value').get()).toEqual({value: 1});
      expect(database).toBeInstanceOf(Database);
    } finally {
      database.close();
    }
  });

  it('commits a bundled addon set matching the pinned better-sqlite3 version', () => {
    expect(() => execFileSync(process.execPath, [path.join(BACKEND, 'scripts/update-better-sqlite3-prebuilts.cjs'), '--check'],
      {stdio: 'pipe'})).not.toThrow();
  });

  it('is the only production module that imports the better-sqlite3 value', () => {
    const offenders: string[] = [];
    const visit = (directory: string): void => {
      for (const entry of fs.readdirSync(directory, {withFileTypes: true})) {
        const file = path.join(directory, entry.name);
        if (entry.isDirectory()) {
          if (entry.name !== '__tests__' && entry.name !== 'tests') visit(file);
        } else if (entry.name.endsWith('.ts') && !entry.name.endsWith('.test.ts') && entry.name !== 'sqliteDatabase.ts') {
          const source = fs.readFileSync(file, 'utf8');
          if (/^import (?!type )[^;]*from 'better-sqlite3';|(?:require|import)\('better-sqlite3'\)(?! as typeof)/m.test(source)) offenders.push(file);
        }
      }
    };
    visit(path.join(BACKEND, 'src'));
    expect(offenders).toEqual([]);
  });
});
