// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import {describe, expect, it} from '@jest/globals';
import {artGcSliceKind, artGcSliceNamePatterns} from '../artGcNames';
import {sqliteGlobRegExp, sqliteLikeRegExp} from '../skillEngine/sqlPatterns';

describe('ART GC slice names', () => {
  it('reads every pattern of the fragment the Skills use', () => {
    expect(artGcSliceNamePatterns().map(({kind}) => kind)).toEqual(
      ['collection', 'collection', 'collection', 'collection', 'wait']);
  });

  it('names the runs and waits the SQL names, and nothing that only says gc', () => {
    const kinds: Array<[string, string | undefined]> = [
      ['Background young concurrent copying GC', 'collection'],
      ['Alloc partial concurrent mark sweep GC', 'collection'],
      ['Background concurrent mark compact GC', 'collection'],
      ['Alloc semispace GC', 'collection'],
      ['GC: Wait For Completion Alloc', 'wait'],
      ['SparseArray.gc()', undefined],
      ['art::gc::Heap::TrimSpaces', undefined],
      ['MetricsCollector', undefined],
      ['Lock contention on GC barrier lock (owner tid: 0)', undefined],
      ['background concurrent copying gc', undefined],
    ];
    expect(kinds.map(([name]) => artGcSliceKind(name))).toEqual(kinds.map(([, kind]) => kind));
  });

  it('converts GLOB as SQLite does: whole string, case-sensitive, ? and classes', () => {
    expect(sqliteGlobRegExp('*GC').test('x GC')).toBe(true);
    expect(sqliteGlobRegExp('*GC').test('x GC y')).toBe(false);
    expect(sqliteGlobRegExp('*GC').test('x gc')).toBe(false);
    expect(sqliteGlobRegExp('a?c').test('abc')).toBe(true);
    expect(sqliteGlobRegExp('[Rr]ead*').test('read(fd)')).toBe(true);
    expect(sqliteGlobRegExp('[^a-z]*').test('Read')).toBe(true);
    expect(sqliteGlobRegExp('a.b(c)').test('a.b(c)')).toBe(true);
    expect(sqliteGlobRegExp('a.b').test('axb')).toBe(false);
    // A ] first in a class is a member; an unterminated class matches nothing
    // here (glob.cc may read a trailing [ as a literal; no Skill pattern has one).
    expect(sqliteGlobRegExp('[^]a]x').test('bx')).toBe(true);
    expect(sqliteGlobRegExp('[^]a]x').test(']x')).toBe(false);
    expect(sqliteGlobRegExp('[]]').test(']')).toBe(true);
    expect(sqliteGlobRegExp('*gpufreq[').test('gpufreq[')).toBe(false);
    expect(sqliteLikeRegExp('%GPU_req%').test('a gpufreq b')).toBe(true);
    expect(sqliteLikeRegExp('a.c').test('abc')).toBe(false);
    // As the pinned trace_processor answers (its GlobMatcher, not SQLite's): an
    // interior dash ranges its neighbours, so ranges chain and a reversed one is
    // empty; a dash first or last is a member.
    const glob = (pattern: string, text: string) => sqliteGlobRegExp(pattern).test(text);
    expect(['a', 'b', 'c', '-'].map(text => glob('[c-a]', text))).toEqual([true, false, true, false]);
    expect(['a', 'd', 'e', 'f', '-'].map(text => glob('[a-c-e]', text))).toEqual([true, true, true, false, false]);
    expect(['a', 'd', 'e', '-'].map(text => glob('[c-a-e]', text))).toEqual([true, true, true, false]);
    expect([glob('[-a]', '-'), glob('[a-]', '-'), glob('[^-a]', '-'), glob('[a-ce]', 'd')]).toEqual([true, true, false, false]);
    // LIKE honours ESCAPE and folds ASCII letters only.
    expect(sqliteLikeRegExp('gpu\\_freq', '\\').test('gpu_freq')).toBe(true);
    expect(sqliteLikeRegExp('gpu\\_freq', '\\').test('gpuxfreq')).toBe(false);
    expect(sqliteLikeRegExp('100!%', '!').test('100%')).toBe(true);
    expect(sqliteLikeRegExp('a\\', '\\').test('a\\')).toBe(false);
    expect(sqliteLikeRegExp('é%').test('É')).toBe(false);
    expect(sqliteLikeRegExp('GPU%').test('gpufreq')).toBe(true);
  });
});
