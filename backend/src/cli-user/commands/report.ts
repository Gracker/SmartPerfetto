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
import * as path from 'path';
import { bootstrap, resolveInvocationPath } from '../bootstrap';
import { loadSession, turnReportPath } from '../io/sessionStore';
import { openPath } from '../io/openFile';
import {parseOutputLanguage} from '../../agentv3/outputLanguage';
import {loadCliAnalysisEvidence, renderCliAnalysisEvidence} from '../services/analysisResultPresentation';
import {sourceUseDecisionForClient} from '../../services/codebase/sourceUseDecision';
import {cliSceneReportMetadata, loadCliSceneReport, renderCliSceneReport} from '../services/sceneReportReference';
import {sanitizeOwnerCodeAwareText} from '../../services/security/codeAwareOutputRegistry';
import {analysisHasPrivateContext} from '../../services/security/analysisPrivateContext';
import type {CliSessionConfig} from '../types';

export interface ReportCommandArgs {
  sessionId: string;
  open: boolean;
  turn?: number;
  envFile?: string;
  sessionDir?: string;
}

export interface ReportExportCommandArgs {
  sessionId: string;
  format: 'html' | 'md' | 'json';
  out: string;
  turn?: number;
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

  const scene = readStoredScene(sp, config, args.turn);
  const sceneText = renderCliSceneReport(scene, parseOutputLanguage(process.env.SMARTPERFETTO_OUTPUT_LANGUAGE));
  if (sceneText) console.log(sceneText);

  const reportPath = args.turn ? turnReportPath(sp, args.turn) : sp.report;
  if (!fs.existsSync(reportPath)) {
    console.error(args.turn
      ? `Error: no turn ${args.turn} HTML report in ${sp.turnsDir}`
      : `Error: no report.html in ${sp.dir}`);
    console.error(`(Report was not generated — run \`smp ask ${args.sessionId} "retry report generation"\` or start a new \`smp run <trace> "question"\`.)`);
    return 1;
  }

  console.log(reportPath);

  if (args.open) {
    const r = openPath(reportPath);
    if (!r.ok) {
      console.error(`Error: ${r.reason}`);
      return 1;
    }
  }

  return 0;
}

export async function runReportExportCommand(args: ReportExportCommandArgs): Promise<number> {
  const outPath = resolveInvocationPath(args.out);
  const { paths } = bootstrap({ envFile: args.envFile, sessionDir: args.sessionDir, requireLlm: false });
  const { sp, config } = loadSession(paths, args.sessionId);

  if (!config) {
    console.error(`Error: no session found at ${sp.dir}`);
    return 1;
  }

  fs.mkdirSync(path.dirname(outPath), { recursive: true });

  switch (args.format) {
    case 'html': {
      const source = args.turn ? turnReportPath(sp, args.turn) : sp.report;
      if (!fs.existsSync(source)) {
        console.error(args.turn
          ? `Error: no turn ${args.turn} HTML report in ${sp.turnsDir}`
          : `Error: no report.html in ${sp.dir}`);
        return 1;
      }
      fs.copyFileSync(source, outPath);
      break;
    }
    case 'md':
      fs.writeFileSync(outPath, args.turn
        ? buildTurnMarkdownExport(sp, args.turn, config)
        : buildMarkdownExport(sp, config), 'utf-8');
      break;
    case 'json':
      fs.writeFileSync(outPath, JSON.stringify(args.turn
        ? buildTurnJsonExport(sp, args.turn, config)
        : buildJsonExport(sp, config), null, 2), 'utf-8');
      break;
    default:
      console.error(`Error: unsupported report format: ${args.format}`);
      return 2;
  }

  console.log(outPath);
  return 0;
}

function buildTurnMarkdownExport(
  sp: ReturnType<typeof loadSession>['sp'],
  turn: number,
  config: NonNullable<ReturnType<typeof loadSession>['config']>,
): string {
  const file = path.join(sp.turnsDir, `${String(turn).padStart(3, '0')}.md`);
  const body = readIfExists(file);
  const evidence = formatStoredEvidence(sp, config.sessionId, turn, body);
  return [
    '# SmartPerfetto CLI Turn Report',
    '',
    `- Session: ${config.sessionId}`,
    `- Turn: ${turn}`,
    `- Trace: ${config.tracePath}`,
    ...(config.referenceTracePath ? [`- Reference Trace: ${config.referenceTracePath}`] : []),
    '',
    body || '*(no turn markdown)*',
    ...(evidence ? ['', evidence] : []),
  ].join('\n');
}

function buildMarkdownExport(sp: ReturnType<typeof loadSession>['sp'], config: NonNullable<ReturnType<typeof loadSession>['config']>): string {
  const conclusion = readIfExists(sp.conclusion);
  const latestTurnMarkdown = readIfExists(path.join(
    sp.turnsDir,
    `${String(config.turnCount).padStart(3, '0')}.md`,
  ));
  const latestEvidence = formatStoredEvidence(
    sp,
    config.sessionId,
    config.turnCount,
    latestTurnMarkdown,
    conclusion,
    true,
  );
  const lines: string[] = [
    '# SmartPerfetto CLI Report',
    '',
    `- Session: ${config.sessionId}`,
    `- Trace: ${config.tracePath}`,
    ...(config.referenceTracePath ? [`- Reference Trace: ${config.referenceTracePath}`] : []),
    `- Turns: ${config.turnCount}`,
    `- Updated: ${new Date(config.lastTurnAt).toISOString()}`,
    '',
    '## Latest Conclusion',
    '',
    conclusion || '*(no conclusion)*',
    ...(latestEvidence ? ['', latestEvidence] : []),
    '',
  ];

  const turnFiles = fs.existsSync(sp.turnsDir)
    ? fs.readdirSync(sp.turnsDir).filter((f) => f.endsWith('.md')).sort()
    : [];
  if (turnFiles.length) {
    lines.push('## Turns', '');
    for (const file of turnFiles) {
      const body = readIfExists(path.join(sp.turnsDir, file));
      const turn = Number.parseInt(file.slice(0, -3), 10);
      lines.push(body, '');
      // The latest evidence is already rendered with Latest Conclusion above.
      if (Number.isSafeInteger(turn) && turn > 0 && turn !== config.turnCount) {
        const evidence = formatStoredEvidence(sp, config.sessionId, turn, body);
        if (evidence) lines.push(evidence, '');
      }
    }
  }
  return lines.join('\n');
}

/** The turn's bound source decision, as the CLI exports it: with its derived counts. */
function storedSourceUseDecision(
  sp: ReturnType<typeof loadSession>['sp'],
  sessionId: string,
  turn: number,
  turnMarkdown: string,
): unknown {
  const loaded = loadCliAnalysisEvidence({sp, sessionId, turn, turnMarkdown});
  return loaded.status === 'available'
    ? sourceUseDecisionForClient(loaded.bundle.evidence.sourceUseDecision)
    : null;
}

function formatStoredEvidence(
  sp: ReturnType<typeof loadSession>['sp'],
  sessionId: string,
  turn: number,
  turnMarkdown: string,
  conclusion?: string,
  latest = false,
): string {
  const evidence = renderCliAnalysisEvidence(loadCliAnalysisEvidence({
    sp,
    sessionId,
    turn,
    turnMarkdown,
    ...(conclusion !== undefined ? {conclusion} : {}),
    latest,
  }), parseOutputLanguage(process.env.SMARTPERFETTO_OUTPUT_LANGUAGE));
  const scene = renderCliSceneReport(loadCliSceneReport({sp, sessionId, turn, turnMarkdown, conclusion, latest}),
    parseOutputLanguage(process.env.SMARTPERFETTO_OUTPUT_LANGUAGE));
  return [evidence, scene].filter(Boolean).join('\n\n');
}

function buildJsonExport(sp: ReturnType<typeof loadSession>['sp'], config: NonNullable<ReturnType<typeof loadSession>['config']>): Record<string, unknown> {
  return {
    ok: true,
    ...cliSceneReportMetadata(readStoredScene(sp, config)),
    config,
    conclusion: readIfExists(sp.conclusion),
    claimSupport: readJsonIfExists(sp.claimSupport, []),
    claimVerificationResult: readJsonIfExists(sp.claimVerification, null),
    identityResolutions: readJsonIfExists(sp.identityResolutions, []),
    transcript: readTranscript(sp.transcript, config),
    files: {
      sessionDir: sp.dir,
      reportHtml: fs.existsSync(sp.report) ? sp.report : null,
      turnReports: listTurnReports(sp),
      conclusion: fs.existsSync(sp.conclusion) ? sp.conclusion : null,
      claimSupport: fs.existsSync(sp.claimSupport) ? sp.claimSupport : null,
      claimVerification: fs.existsSync(sp.claimVerification) ? sp.claimVerification : null,
      identityResolutions: fs.existsSync(sp.identityResolutions) ? sp.identityResolutions : null,
      transcript: fs.existsSync(sp.transcript) ? sp.transcript : null,
    },
  };
}

function buildTurnJsonExport(
  sp: ReturnType<typeof loadSession>['sp'],
  turn: number,
  config: NonNullable<ReturnType<typeof loadSession>['config']>,
): Record<string, unknown> {
  const htmlPath = turnReportPath(sp, turn);
  const mdPath = path.join(sp.turnsDir, `${String(turn).padStart(3, '0')}.md`);
  const turnPrefix = path.join(sp.turnsDir, String(turn).padStart(3, '0'));
  const transcript = readTranscript(sp.transcript, config);
  return {
    ok: true,
    ...cliSceneReportMetadata(readStoredScene(sp, config, turn)),
    config,
    turn,
    turnMarkdown: readIfExists(mdPath),
    sourceUseDecision: storedSourceUseDecision(sp, config.sessionId, turn, readIfExists(mdPath)),
    claimSupport: readJsonIfExists(`${turnPrefix}.claim-support.json`, []),
    claimVerificationResult: readJsonIfExists(`${turnPrefix}.claim-verification.json`, null),
    identityResolutions: readJsonIfExists(`${turnPrefix}.identity-resolutions.json`, []),
    transcriptTurn: transcript.find((entry: any) => entry?.turn === turn) ?? null,
    files: {
      sessionDir: sp.dir,
      reportHtml: fs.existsSync(htmlPath) ? htmlPath : null,
      turnMarkdown: fs.existsSync(mdPath) ? mdPath : null,
      claimSupport: fs.existsSync(`${turnPrefix}.claim-support.json`) ? `${turnPrefix}.claim-support.json` : null,
      claimVerification: fs.existsSync(`${turnPrefix}.claim-verification.json`) ? `${turnPrefix}.claim-verification.json` : null,
      identityResolutions: fs.existsSync(`${turnPrefix}.identity-resolutions.json`) ? `${turnPrefix}.identity-resolutions.json` : null,
      transcript: fs.existsSync(sp.transcript) ? sp.transcript : null,
    },
  };
}

function readStoredScene(sp: ReturnType<typeof loadSession>['sp'], config: NonNullable<ReturnType<typeof loadSession>['config']>, turn?: number) {
  const selectedTurn = turn ?? config.turnCount;
  return loadCliSceneReport({sp, sessionId: config.sessionId, turn: selectedTurn,
    turnMarkdown: readIfExists(path.join(sp.turnsDir, `${String(selectedTurn).padStart(3, '0')}.md`)),
    ...(turn === undefined ? {traceId: config.traceId, conclusion: readIfExists(sp.conclusion), latest: true} : {})});
}

function listTurnReports(sp: ReturnType<typeof loadSession>['sp']): string[] {
  if (!fs.existsSync(sp.turnsDir)) return [];
  return fs
    .readdirSync(sp.turnsDir)
    .filter((f) => f.endsWith('.html'))
    .sort()
    .map((f) => path.join(sp.turnsDir, f));
}

function readIfExists(file: string): string {
  try {
    return fs.existsSync(file) ? fs.readFileSync(file, 'utf-8') : '';
  } catch {
    return '';
  }
}

function readJsonIfExists(file: string, fallback: unknown): unknown {
  try {
    return fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf-8')) : fallback;
  } catch {
    return fallback;
  }
}

/**
 * A private turn stores its question verbatim because resume reads it as model
 * history; an export is the creator's view, which masks credentials. The run's
 * guards died with its process, so only the credential patterns apply here.
 * A line that does not parse may still hold a private question whose marker
 * cannot be read, so its text is left out; resume skips it too. A row written
 * before turns carried a marker follows the session's selection, as resume does.
 */
function readTranscript(file: string, config: CliSessionConfig): unknown[] {
  if (!fs.existsSync(file)) return [];
  const legacySourceDerived = analysisHasPrivateContext(config);
  const project = (value: unknown) => typeof value === 'string' ? sanitizeOwnerCodeAwareText(undefined, value) : value;
  return fs
    .readFileSync(file, 'utf-8')
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      let turn: any;
      try { turn = JSON.parse(line); } catch { return {unreadable: true}; }
      if (!turn || typeof turn !== 'object' || Array.isArray(turn)) return {unreadable: true};
      if (!(turn.history ? turn.history.sourceDerived === true : legacySourceDerived)) return turn;
      return {...turn, question: project(turn.question),
        ...(turn.history ? {history: {...turn.history, query: project(turn.history.query)}} : {})};
    });
}
