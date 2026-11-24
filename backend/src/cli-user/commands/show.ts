// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

/**
 * `smartperfetto show <sessionId>` — print a session's latest conclusion
 * and report location. Optional `--open` opens the HTML report.
 */

import * as fs from 'fs';
import * as path from 'path';
import { bootstrap } from '../bootstrap';
import { loadSession } from '../io/sessionStore';
import { openPath } from '../io/openFile';
import {localize, parseOutputLanguage} from '../../agentv3/outputLanguage';
import {loadCliAnalysisEvidence, renderCliAnalysisEvidence} from '../services/analysisResultPresentation';
import {loadCliSceneReport, renderCliSceneReport} from '../services/sceneReportReference';

export interface ShowCommandArgs {
  sessionId: string;
  open: boolean;
  envFile?: string;
  sessionDir?: string;
}

export async function runShowCommand(args: ShowCommandArgs): Promise<number> {
  const { paths } = bootstrap({ envFile: args.envFile, sessionDir: args.sessionDir, requireLlm: false });
  const { sp, config } = loadSession(paths, args.sessionId);

  if (!config) {
    console.error(`Error: no session found at ${sp.dir}`);
    return 1;
  }

  // Header: session metadata. Short format — full details belong in `list --json`.
  console.log(`session  ${args.sessionId}`);
  console.log(`trace    ${config.tracePath}`);
  console.log(`turns    ${config.turnCount}`);
  console.log(`updated  ${new Date(config.lastTurnAt).toISOString()}`);
  console.log('');

  // Body: latest conclusion. Session folder always has conclusion.md after
  // the first turn — if it's missing the session is corrupt or mid-analysis.
  const conclusion = readIfExists(sp.conclusion);
  const turnMarkdown = readIfExists(path.join(sp.turnsDir, `${String(config.turnCount).padStart(3, '0')}.md`));
  if (fs.existsSync(sp.conclusion)) {
    const evidence = loadCliAnalysisEvidence({
      sp,
      sessionId: config.sessionId,
      turn: config.turnCount,
      conclusion,
      turnMarkdown,
      latest: true,
    });
    const language = parseOutputLanguage(process.env.SMARTPERFETTO_OUTPUT_LANGUAGE);
    if (evidence.status === 'available' && evidence.bundle.evidence.conclusionEvidence) {
      console.log(evidence.bundle.evidence.conclusionEvidence.markdown);
      console.log('');
      console.log(localize(language, '## 模型分析', '## Model analysis'));
      console.log('');
    }
    console.log(conclusion);
    const evidenceText = renderCliAnalysisEvidence(
      evidence,
      language,
    );
    if (evidenceText) console.log(`\n${evidenceText}`);
  } else {
    console.log('(no conclusion yet — session is pending or incomplete)');
  }
  const sceneText = renderCliSceneReport(loadCliSceneReport({sp, sessionId: config.sessionId,
    traceId: config.traceId, turn: config.turnCount, conclusion, turnMarkdown, latest: true}),
  parseOutputLanguage(process.env.SMARTPERFETTO_OUTPUT_LANGUAGE));
  if (sceneText) console.log(`\n${sceneText}`);

  // Footer: report pointer. Surface always, even without --open, so the user
  // can copy it into a browser manually.
  if (fs.existsSync(sp.report)) {
    console.log(`\nreport: ${sp.report}`);
    if (args.open) {
      const r = openPath(sp.report);
      if (!r.ok) console.error(`(open failed: ${r.reason})`);
    }
  } else if (args.open) {
    console.error('(no report.html in session folder — nothing to open)');
  }

  return 0;
}

function readIfExists(file: string): string {
  try {
    return fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
  } catch {
    return '';
  }
}
