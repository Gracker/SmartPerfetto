// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

/**
 * `smartperfetto report <sessionId>` — print or open the session's HTML report.
 *
 * PR2 supports `--open` only. `--rebuild` (regenerate from stream.jsonl) is
 * deferred — it requires replaying the orchestrator-populated session fields
 * that `analyze` collects at run time, which isn't trivially possible from
 * the raw event stream alone.
 */

import * as fs from 'fs';
import { bootstrap } from '../bootstrap';
import { loadSession } from '../io/sessionStore';
import { openPath } from '../io/openFile';

export interface ReportCommandArgs {
  sessionId: string;
  open: boolean;
  envFile?: string;
  sessionDir?: string;
}

export async function runReportCommand(args: ReportCommandArgs): Promise<number> {
  const { paths } = bootstrap({ envFile: args.envFile, sessionDir: args.sessionDir, requireLlm: false });
  const { sp, config } = loadSession(paths, args.sessionId);

  if (!config) {
    console.error(`Error: no session found at ${sp.dir}`);
    return 1;
  }

  if (!fs.existsSync(sp.report)) {
    console.error(`Error: no report.html in ${sp.dir}`);
    console.error('(Report was not generated — re-run `smp -f <trace> -p "question"` or `smp resume` to retry.)');
    return 1;
  }

  console.log(sp.report);

  if (args.open) {
    const r = openPath(sp.report);
    if (!r.ok) {
      console.error(`Error: ${r.reason}`);
      return 1;
    }
  }

  return 0;
}
