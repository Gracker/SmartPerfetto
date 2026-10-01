// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

/**
 * The parse boundary for persisted data: store files, DB columns, registered
 * knowledge, packs and JSONL records.
 *
 * A parser's error quotes the text it failed on (V8's `Unexpected token`
 * messages, js-yaml's snippets), and a store's error travels on to responses,
 * reports, SSE, persisted error codes and logs. `StoredDataError` names the
 * store and keeps only a line and column, and it has no `cause`, which Node
 * would print with it.
 */

import yaml from 'js-yaml';

export type StoredDataReason = 'invalid_json' | 'invalid_yaml';

/** 1-based line and column in the stored file; never the text itself. */
export interface StoredDataLocation {
  line?: number;
  column?: number;
}

export interface StoredDataParseOptions {
  /** The reader wrote this text (a config, pack or knowledge file), so the message gives the position. */
  authored?: boolean;
  /** The file line the text starts on, for a fragment or a JSONL record. */
  startLine?: number;
}

export class StoredDataError extends Error {
  override readonly name = 'StoredDataError';

  constructor(
    /** A fixed noun phrase from the caller, never a path, tenant or user value. */
    readonly store: string,
    readonly reason: StoredDataReason,
    readonly location: StoredDataLocation,
    readonly byteLength: number,
    authored: boolean,
  ) {
    super(`${store} is not valid ${reason === 'invalid_yaml' ? 'YAML' : 'JSON'}${authored && location.line !== undefined
      ? ` (line ${location.line}, column ${location.column})` : ''}`);
  }
}

// V8's content-free messages end in "in JSON at position 8 (line 1 column 9)"
// or "after JSON at position 22 (...)" and hold no double quote. Its quoting
// form, `Unexpected token 'x', "<text>" is not valid JSON`, can itself quote
// "at position 123", so a position is read only from the anchored form.
const V8_JSON_POSITION = /(?:in|after) JSON at position (\d+)(?: \(line \d+ column \d+\))?$/;

/** The line and column of a string offset, in file lines. */
function lineAndColumn(text: string, offset: number, startLine: number): StoredDataLocation {
  const before = text.slice(0, offset);
  const lineStart = before.lastIndexOf('\n') + 1;
  return {line: startLine + before.split('\n').length - 1, column: offset - lineStart + 1};
}

function jsonLocation(error: unknown, text: string, startLine: number): StoredDataLocation {
  const message = error instanceof Error ? error.message : '';
  const position = message.includes('"') ? null : V8_JSON_POSITION.exec(message);
  if (position) return lineAndColumn(text, Number(position[1]), startLine);
  return message === 'Unexpected end of JSON input' ? lineAndColumn(text, text.length, startLine) : {};
}

function storedDataError(store: string, reason: StoredDataReason, location: StoredDataLocation, text: string,
  options: StoredDataParseOptions): StoredDataError {
  return new StoredDataError(store, reason, location, Buffer.byteLength(text, 'utf8'), options.authored === true);
}

/** Parse persisted JSON; a failure throws `StoredDataError`, never the parser's own error. */
export function parseStoredJson<T = unknown>(text: string, store: string, options: StoredDataParseOptions = {}): T {
  try {
    return JSON.parse(text) as T;
  } catch (error) {
    throw storedDataError(store, 'invalid_json', jsonLocation(error, text, options.startLine ?? 1), text, options);
  }
}

/** For a reader that degrades on a parse failure instead of failing. */
export function tryParseStoredJson<T = unknown>(text: string, store: string, options: StoredDataParseOptions = {}):
  {ok: true; value: T} | {ok: false; error: StoredDataError} {
  try {
    return {ok: true, value: parseStoredJson<T>(text, store, options)};
  } catch (error) {
    if (error instanceof StoredDataError) return {ok: false, error};
    throw error;
  }
}

/** Parse persisted YAML; only the line and column of js-yaml's mark survive a failure. */
export function parseStoredYaml<T = unknown>(text: string, store: string, options: StoredDataParseOptions = {}): T {
  try {
    return yaml.load(text) as T;
  } catch (error) {
    const mark = error instanceof yaml.YAMLException ? error.mark : undefined;
    const location: StoredDataLocation = mark && Number.isSafeInteger(mark.line) && Number.isSafeInteger(mark.column)
      ? {line: (options.startLine ?? 1) + mark.line, column: mark.column + 1} : {};
    throw storedDataError(store, 'invalid_yaml', location, text, options);
  }
}

/** The reason a store with its own recovery code puts after the code. */
export function storedDataReason(error: unknown): string {
  if (error instanceof StoredDataError) return error.reason;
  return error instanceof Error ? error.message : String(error);
}

/**
 * Log a store's read failure: a parse failure by store, reason, size and
 * position only, any other failure (a path that cannot be read) by its message.
 */
export function logStoredReadFailure(
  prefix: string,
  error: unknown,
  context: Readonly<Record<string, string | number>> = {},
): void {
  console.warn(prefix, error instanceof StoredDataError
    ? {...context, store: error.store, reason: error.reason, bytes: error.byteLength, ...error.location}
    : {...context, error: error instanceof Error ? error.message : String(error)});
}
