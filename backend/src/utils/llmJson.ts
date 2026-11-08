// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

export function isPlainObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

/**
 * Strict protocol parsing of a model's JSON reply: a bounded single object, an
 * optional whole-reply code fence, nothing else. Prose around the JSON is not
 * a response; any deviation is undefined so the caller can fail closed.
 */
export function parseStrictJsonObject(text: string, maxBytes: number): Record<string, unknown> | undefined {
  if (Buffer.byteLength(text, 'utf8') > maxBytes) return undefined;
  const trimmed = text.trim();
  const fenced = /^```(?:json)?\s*\n([\s\S]*)\n```$/.exec(trimmed);
  try {
    const parsed: unknown = JSON.parse(fenced ? fenced[1] : trimmed);
    return isPlainObject(parsed) ? parsed : undefined;
  } catch { return undefined; }
}
