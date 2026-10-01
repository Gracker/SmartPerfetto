// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import {describe, expect, it} from '@jest/globals';
import {inspect} from 'util';
import {warningsDuring} from '../../../tests/helpers/consoleWarnings';
import {
  logStoredReadFailure,
  parseStoredJson,
  parseStoredYaml,
  StoredDataError,
  storedDataReason,
  tryParseStoredJson,
} from '../storedData';

// Unquoted, so V8 quotes the text around it in its own message.
const CANARY = 'SECRET-CANARY-7f3a';

function caught(parse: () => unknown): StoredDataError {
  try {
    parse();
  } catch (error) {
    expect(error).toBeInstanceOf(StoredDataError);
    return error as StoredDataError;
  }
  throw new Error('expected a StoredDataError');
}

/** Every way the error can reach a response, a report or a log line. */
function renderings(error: StoredDataError): string[] {
  return [error.message, String(error), error.stack ?? '', inspect(error, {depth: 5}), JSON.stringify(error),
    JSON.stringify(warningsDuring(() => logStoredReadFailure('[Test] Store unreadable', error, {path: '/data/x.json'})))];
}

describe('stored data parse boundary', () => {
  it('parses valid JSON and YAML unchanged', () => {
    expect(parseStoredJson('{"a":[1,"b"]}', 'test store')).toEqual({a: [1, 'b']});
    expect(tryParseStoredJson('[1]', 'test store')).toEqual({ok: true, value: [1]});
    expect(parseStoredYaml('a:\n  - 1\n  - b\n', 'test pack')).toEqual({a: [1, 'b']});
  });

  it('never quotes the JSON it failed on', () => {
    for (const text of [`[{"k":[${CANARY} x]}]`, `not-json ${CANARY}`, `{"a":"${CANARY}"} trailing`]) {
      const error = caught(() => parseStoredJson(text, 'test store'));
      expect(error.message).toBe('test store is not valid JSON');
      expect(error).toMatchObject({name: 'StoredDataError', store: 'test store', reason: 'invalid_json',
        byteLength: Buffer.byteLength(text)});
      expect('cause' in error).toBe(false);
      for (const rendered of renderings(error)) expect(rendered).not.toContain(CANARY);
    }
  });

  it('keeps only content-free file positions', () => {
    expect(caught(() => parseStoredJson('{"é": 1,}', 'test store')).location).toEqual({line: 1, column: 9});
    // The end of the input is a position too, counted in file lines.
    expect(caught(() => parseStoredJson('{\n"a": ', 'test store')).location).toEqual({line: 2, column: 6});
    // A JSONL record or a fragment reports the file's line.
    expect(caught(() => parseStoredJson('{"a": 1,}', 'ledger', {startLine: 4})).location).toEqual({line: 4, column: 9});
    // `Unexpected token` messages name the character and quote the text: nothing is taken
    // from them, not even quoted text that reads like a position. This one is short enough
    // for V8 to quote whole, digits included.
    const numeric = caught(() => parseStoredJson('at position 8675309', 'test store'));
    expect(numeric.location).toEqual({});
    for (const rendered of renderings(numeric)) expect(rendered).not.toContain('8675309');
  });

  it('gives the position in the message only when its reader wrote the text', () => {
    expect(caught(() => parseStoredJson('{"a": 1,}', 'model JSON', {authored: true})).message)
      .toBe('model JSON is not valid JSON (line 1, column 9)');
    expect(caught(() => parseStoredJson('{"a": 1,}', 'record')).message).toBe('record is not valid JSON');
  });

  it('never quotes the YAML it failed on', () => {
    const error = caught(() => parseStoredYaml(`key: [${CANARY}\n`, 'frontmatter', {authored: true, startLine: 2}));
    expect(error.message).toBe('frontmatter is not valid YAML (line 3, column 1)');
    expect(error).toMatchObject({reason: 'invalid_yaml', location: {line: 3, column: 1}});
    for (const rendered of renderings(error)) expect(rendered).not.toContain(CANARY);
  });

  it('lets a degrading reader branch, and a recovery code keep a fixed reason', () => {
    const failed = tryParseStoredJson(`[${CANARY}]`, 'test store');
    expect(failed).toMatchObject({ok: false, error: {message: 'test store is not valid JSON'}});
    expect(storedDataReason(caught(() => parseStoredJson(`[${CANARY}]`, 'test store')))).toBe('invalid_json');
    expect(storedDataReason(new Error('unsupported_schema'))).toBe('unsupported_schema');
  });

  it('logs any other read failure by its message', () => {
    expect(warningsDuring(() => logStoredReadFailure('[Test] Store unreadable', new Error('EACCES: permission denied'),
      {path: '/data/x.json'}))).toEqual([['[Test] Store unreadable', {path: '/data/x.json', error: 'EACCES: permission denied'}]]);
  });
});
