// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import { PublicRequestError } from '../../utils/publicRequestError';

/**
 * A codebase registration or index request the caller has to change: an
 * invalid selection field, kind or required metadata, or an unknown codebase.
 * The message names the field; it never carries a filesystem or storage error.
 */
export type CodebaseRequestErrorCode =
  | 'CODEBASE_METADATA_INVALID'
  | 'CODEBASE_NOT_FOUND'
  | 'CODEBASE_SELECTION_INVALID'
  | 'PENDING_GENERATION_ID_INVALID';

export class CodebaseRequestError extends PublicRequestError {
  declare readonly code: CodebaseRequestErrorCode;

  constructor(code: CodebaseRequestErrorCode, message: string, status = 400) {
    super(code, message, status);
  }
}

export function invalidCodebaseSelection(message: string): CodebaseRequestError {
  return new CodebaseRequestError('CODEBASE_SELECTION_INVALID', message);
}

export function invalidCodebaseMetadata(message: string): CodebaseRequestError {
  return new CodebaseRequestError('CODEBASE_METADATA_INVALID', message);
}

export function codebaseNotFound(codebaseId: string): CodebaseRequestError {
  return new CodebaseRequestError('CODEBASE_NOT_FOUND', `Codebase '${codebaseId}' not found`, 404);
}

/**
 * A codebase state the caller has to wait for or act on: a deletion or reindex
 * in progress, a lost index lease, a pending generation that is missing, stale
 * or expired, provider-send consent not granted, or a root whose real path
 * changed. The message is the reason token, which stored ingest diagnostics
 * and route reason answers already carry; classify by `reason`, never by text.
 */
export type CodebaseStateReason =
  | 'codebase_deleting'
  | 'codebase_reindex_in_progress'
  | 'codebase_reindex_lease_lost'
  | 'codebase_root_realpath_drift'
  | 'pending_generation_expired'
  | 'pending_generation_not_found'
  | 'pending_generation_stale'
  | 'provider_send_consent_required';

export class CodebaseStateError extends Error {
  constructor(readonly reason: CodebaseStateReason) {
    super(reason);
    this.name = 'CodebaseStateError';
  }
}

export function isCodebaseStateError(
  error: unknown,
  ...reasons: CodebaseStateReason[]
): error is CodebaseStateError {
  return error instanceof CodebaseStateError && (reasons.length === 0 || reasons.includes(error.reason));
}
