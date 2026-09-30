// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import path from 'path';

/**
 * The one resolver for upload and trace directories. The upload routes, trace
 * metadata and TraceProcessorService's reload-from-disk must agree: the
 * portable launcher sets only `UPLOAD_DIR` while the backend's cwd is inside
 * the package. `SMARTPERFETTO_TRACE_UPLOAD_DIR` overrides only the trace
 * directory (the CLI keeps trace copies under its own home).
 */
const TRACE_UPLOAD_DIR_ENV = 'SMARTPERFETTO_TRACE_UPLOAD_DIR';

export function getUploadRoot(env: NodeJS.ProcessEnv = process.env): string {
  return env.UPLOAD_DIR?.trim() || './uploads';
}

export function getTracesDir(env: NodeJS.ProcessEnv = process.env): string {
  return env[TRACE_UPLOAD_DIR_ENV]?.trim() || path.join(getUploadRoot(env), 'traces');
}
