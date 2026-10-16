// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

const CLOSED_CODE = /^[a-z][a-z0-9_]{0,63}$/;

/**
 * A closed machine code such as `source_file_not_found`: lower-case, short and
 * free of paths or punctuation, so it is safe to pass to any audience. Error
 * messages that are not one may carry a filesystem detail.
 */
export function isClosedCode(value: unknown): value is string {
  return typeof value === 'string' && CLOSED_CODE.test(value);
}
