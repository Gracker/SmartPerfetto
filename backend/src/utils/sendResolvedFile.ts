// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import path from 'path';
import type {Response} from 'express';

/**
 * Sends a file whose path the server resolved itself (trace metadata, a fixed
 * asset), never one taken from the request.
 *
 * A rootless `res.sendFile` applies send's `dotfiles: 'ignore'` rule to every
 * segment of the absolute path, so a file below `~/.local/share` (the Linux
 * portable data root) or `.claude/worktrees` answered 404. Rooting at the
 * parent directory applies the rule to the file name alone: a dotfile is still
 * refused, its directories are not.
 */
export function sendResolvedFile(
  res: Response,
  filePath: string,
  callback?: (error?: Error) => void,
): void {
  const resolved = path.resolve(filePath);
  res.sendFile(path.basename(resolved), {root: path.dirname(resolved)}, callback);
}
