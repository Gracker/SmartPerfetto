// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import * as childProcess from 'child_process';
import * as fs from 'fs';
import * as path from 'path';

/**
 * Points a repository's local `core.fsmonitor` at a hook that records when git
 * runs it. A registered checkout controls that config, and git executes the
 * hook on status unless the caller disables it, so every hardened git caller
 * must leave `executed()` false. The hook lives under `.git/`: it is cleaned
 * up with the repository and never shows up as an untracked file.
 */
export function installGitFsmonitorCanary(repositoryRoot: string): {executed: () => boolean} {
  const gitDirectory = path.join(repositoryRoot, '.git');
  const marker = path.join(gitDirectory, 'smartperfetto-fsmonitor-executed');
  const hook = path.join(gitDirectory, 'smartperfetto-fsmonitor-hook.sh');
  fs.writeFileSync(hook, ['#!/bin/sh', `touch '${marker}'`, 'exit 0', ''].join('\n'));
  fs.chmodSync(hook, 0o700);
  childProcess.execFileSync('git', ['config', 'core.fsmonitor', hook], {cwd: repositoryRoot});
  return {executed: () => fs.existsSync(marker)};
}
