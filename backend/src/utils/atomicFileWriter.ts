// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

/**
 * Atomic file-write helpers.
 *
 * The pattern is "write to a unique tmp file, then rename into place":
 * POSIX rename on the same filesystem is atomic, so the destination is
 * always either the prior content or the new content, never a partial
 * write. The tmp suffix includes pid + timestamp + random bits so
 * concurrent writers don't collide on the same tmp path.
 *
 * Both sync and async variants exist because different call sites have
 * different constraints: CLI command handlers are synchronous tops-to-
 * tails, while service-layer stores prefer `fs.promises`. Unifying on a
 * single style would propagate a signature change through many callers
 * for no real benefit.
 */

import * as fs from 'fs';
import * as fsp from 'fs/promises';

function makeTmpPath(target: string): string {
  return `${target}.tmp.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2, 8)}`;
}

/** Atomic write — synchronous variant. */
export function atomicWriteFileSync(target: string, content: string | Buffer): void {
  const tmp = makeTmpPath(target);
  try {
    fs.writeFileSync(tmp, content);
    fs.renameSync(tmp, target);
  } catch (err) {
    // A partial write (ENOSPC) or a failed rename (cross-device) — drop the
    // orphaned tmp before surfacing the error.
    try { fs.unlinkSync(tmp); } catch { /* ignore */ }
    throw err;
  }
}

/** Atomic write — asynchronous variant, for fs/promises call sites. */
export async function atomicWriteFile(target: string, content: string | Buffer): Promise<void> {
  const tmp = makeTmpPath(target);
  try {
    await fsp.writeFile(tmp, content);
    await fsp.rename(tmp, target);
  } catch (err) {
    await fsp.unlink(tmp).catch(() => undefined);
    throw err;
  }
}
