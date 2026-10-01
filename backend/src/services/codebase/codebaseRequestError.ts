// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import { PublicRequestError } from '../../utils/publicRequestError';

/**
 * A codebase registration or index request the caller has to change: an
 * invalid selection field, kind or required metadata, or an unknown codebase.
 * The message names the field; it never carries a filesystem or storage error.
 */
export class CodebaseRequestError extends PublicRequestError {}

export function invalidCodebaseSelection(message: string): CodebaseRequestError {
  return new CodebaseRequestError('CODEBASE_SELECTION_INVALID', message);
}

export function invalidCodebaseMetadata(message: string): CodebaseRequestError {
  return new CodebaseRequestError('CODEBASE_METADATA_INVALID', message);
}

export function codebaseNotFound(codebaseId: string): CodebaseRequestError {
  return new CodebaseRequestError('CODEBASE_NOT_FOUND', `Codebase '${codebaseId}' not found`, 404);
}
