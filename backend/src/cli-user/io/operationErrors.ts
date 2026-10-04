// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

/**
 * How the management commands (`smp codebase`, `smp knowledge`) report a
 * failure: a JSON payload on stdout for `--format json`, one line on stderr
 * otherwise, and an exit code from the error's HTTP status.
 */

import type {PublicRequestError} from '../../utils/publicRequestError';

/** Exit code from a request error's HTTP status: input 2, not found 3, conflict 4, anything else 5. */
function requestErrorExitCode(status: number): number {
  if (status === 400) return 2;
  if (status === 404) return 3;
  if (status === 409) return 4;
  return 5;
}

function writeFailure(json: boolean, payload: {code: string; error: string} & Record<string, unknown>, line: string): void {
  if (json) console.log(JSON.stringify({success: false, ...payload}, null, 2));
  else console.error(line);
}

/** Input the command rejected before running anything; exit 2. */
export function writeCliInputError(json: boolean, code: string, message: string): number {
  writeFailure(json, {code, error: message}, `${code}: ${message}`);
  return 2;
}

/**
 * A failed operation. A typed request error keeps its product code, text and
 * details; any other failure shows only the fallback (plus its reason token
 * when one is given), never a message that could quote stored data.
 */
export function writeCliOperationError(
  json: boolean,
  typed: PublicRequestError | undefined,
  fallback: {code: string; message: string; reason?: string},
): number {
  const reason = typed ? undefined : fallback.reason;
  const payload = {
    code: typed?.code ?? fallback.code,
    error: typed?.message ?? fallback.message,
    ...(typed?.details ? {details: typed.details} : {}),
    ...(reason ? {reason} : {}),
  };
  writeFailure(json, payload, `${payload.code}: ${payload.error}${reason ? ` (${reason})` : ''}`);
  return typed ? requestErrorExitCode(typed.status) : 5;
}
