// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import { PublicRequestError } from '../../utils/publicRequestError';

/** A batch trace request the caller has to change: a missing input, an unknown skill or an invalid limit. */
export class BatchTraceRequestError extends PublicRequestError {}

export function invalidBatchTraceRequest(message: string): BatchTraceRequestError {
  return new BatchTraceRequestError('invalid_batch_trace_request', message);
}
